import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Check, ChevronRight, Monitor, Star, X } from "lucide-react";

import "./chat.css";
import "./report.css";

export interface RemoteMachine {
  id: string;
  name: string;
  kind: string;
  platform?: string | null;
  online: boolean;
  hostOnline: boolean;
  canHost: boolean;
  remoteAllowed: boolean;
}

export interface RemoteProjectOption {
  project: string;
  description?: string | null;
  git?: boolean;
}

/** One folder on the host, as the browse RPC lists it. */
export interface RemoteFolderOption {
  name: string;
  path: string;
  /** The host has it starred, so it is one of the shortcuts at the top. */
  pinned?: boolean;
}

/**
 * One level of a host's folders. `path` is null at the top, where the entries
 * are the folders starred on that machine followed by the places browsing
 * starts from: home, the projects folder, the drives.
 */
export interface RemoteFolderListing {
  path: string | null;
  parent: string | null;
  entries: RemoteFolderOption[];
  truncated: boolean;
}

/** Where the conversation should start on its host. */
export interface RemoteChatTarget {
  project?: string;
  folder?: string;
}

/**
 * Choosing where a direct coding chat lives.
 *
 * The conversation is created on the host, next to its folder and engine; this
 * window only keeps a cache. A project is a name the account already knows; a
 * folder is a path the controller walked to through the host, one level at a
 * time. Either way the host resolves the folder, so no path is ever guessed.
 * Shared by the desktop window and the phone so both ask the same question.
 */
export function RemoteChatDialog({
  devices,
  selfId,
  onClose,
  loadProjects,
  createProject,
  loadFolders,
  pinFolder,
  onCreate,
}: {
  devices: RemoteMachine[];
  /** This device's id. A host here would create the chat in the same store. */
  selfId: string;
  onClose: () => void;
  loadProjects: (deviceId: string) => Promise<RemoteProjectOption[]>;
  /** Create a folder on the host. Absent in a build that cannot reach one. */
  createProject?: (
    deviceId: string,
    name: string,
    description: string,
  ) => Promise<RemoteProjectOption>;
  /** Walk the host's folders one level at a time. Absent without a host. */
  loadFolders?: (
    deviceId: string,
    path: string | null,
  ) => Promise<RemoteFolderListing>;
  /**
   * Star or unstar one of the host's folders. The star lives on the host, so
   * the shortcut is there for every device of the account; the answer is the
   * host's whole list. Absent without a host.
   */
  pinFolder?: (
    deviceId: string,
    path: string,
    pinned: boolean,
  ) => Promise<string[]>;
  onCreate: (deviceId: string, target: RemoteChatTarget) => Promise<void>;
}) {
  const machines = devices.filter(
    (machine) =>
      machine.id !== selfId &&
      machine.canHost &&
      machine.hostOnline &&
      machine.remoteAllowed,
  );
  const [machineId, setMachineId] = useState<string | null>(
    machines[0]?.id ?? null,
  );
  const [projects, setProjects] = useState<RemoteProjectOption[] | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [mode, setMode] = useState<"project" | "folder">("project");
  const [folder, setFolder] = useState<string | null>(null);
  const [listing, setListing] = useState<RemoteFolderListing | null>(null);
  const [folderLoading, setFolderLoading] = useState(false);
  /** The host's starred folders, in its own order. The listing's flags seed
   * this, the pin RPC is what changes it, and every star is drawn from here. */
  const [pinned, setPinned] = useState<string[]>([]);
  const [pinBusy, setPinBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!machines.some((machine) => machine.id === machineId)) {
      setMachineId(machines[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines.map((machine) => machine.id).join("|")]);

  useEffect(() => {
    if (!machineId) {
      setProjects(null);
      setProject(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setProjects(null);
    setProject(null);
    setFolder(null);
    setListing(null);
    setPinned([]);
    setError(null);
    setCreating(false);
    setNewName("");
    setNewDescription("");
    void loadProjects(machineId)
      .then((list) => {
        if (!alive) return;
        setProjects(list);
        setProject(list[0]?.project ?? null);
      })
      .catch((caught) => {
        if (alive) setError(textOf(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [machineId, loadProjects]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // One level of the host's folders, re-read whenever the walk moves.
  useEffect(() => {
    if (mode !== "folder" || !machineId || !loadFolders) return;
    let alive = true;
    setFolderLoading(true);
    setListing(null);
    setError(null);
    void loadFolders(machineId, folder)
      .then((level) => {
        if (!alive) return;
        setListing(level);
        // The top level is the one answer that carries the whole starred list.
        if (level.path === null) {
          setPinned(
            level.entries
              .filter((entry) => entry.pinned)
              .map((entry) => entry.path),
          );
        }
      })
      .catch((caught) => {
        if (alive) setError(textOf(caught));
      })
      .finally(() => {
        if (alive) setFolderLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mode, machineId, folder, loadFolders]);

  const togglePin = async (path: string) => {
    if (!machineId || !pinFolder || pinBusy) return;
    const on = isPinnedPath(pinned, path);
    setPinBusy(path);
    setError(null);
    try {
      setPinned(await pinFolder(machineId, path, !on));
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setPinBusy(null);
    }
  };

  const create = async () => {
    if (!machineId || !createProject || !newName.trim() || projectBusy) return;
    setProjectBusy(true);
    setError(null);
    try {
      const created = await createProject(
        machineId,
        newName.trim(),
        newDescription.trim(),
      );
      setProjects((current) => [
        ...(current ?? []).filter((entry) => entry.project !== created.project),
        created,
      ]);
      setProject(created.project);
      setCreating(false);
      setNewName("");
      setNewDescription("");
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setProjectBusy(false);
    }
  };

  const start = async () => {
    if (!machineId || !target || busy || creating || projectBusy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(machineId, target);
      onClose();
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const machine = machines.find((entry) => entry.id === machineId);
  // The top level draws the host's shortcuts first: the folders it starred,
  // each one still a click away the next time this picker opens.
  const atTop = listing?.path === null;
  const pinnedRows = !atTop
    ? []
    : pinned.map(
        (path) =>
          listing?.entries.find((entry) => samePath(entry.path, path)) ?? {
            name: baseName(path),
            path,
            pinned: true,
          },
      );
  const placeRows = !listing
    ? []
    : atTop
      ? listing.entries.filter((entry) => !isPinnedPath(pinned, entry.path))
      : listing.entries;
  const target: RemoteChatTarget | null =
    mode === "folder"
      ? listing?.path
        ? { folder: listing.path }
        : null
      : project
        ? { project }
        : null;

  return createPortal(
    <div className="report-backdrop" onMouseDown={onClose}>
      <div
        className="report-dialog remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-chat-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="report-head">
          <span className="report-icon" aria-hidden="true">
            <Monitor strokeWidth={1.8} />
          </span>
          <div className="report-title-copy">
            <h2 id="remote-chat-title">Code on another machine</h2>
            <p>
              The conversation lives on that computer, next to its folder. This
              device keeps a copy you can read here; it never uploads the
              transcript.
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X strokeWidth={2} />
          </button>
        </div>

        {machines.length === 0 ? (
          <p className="remote-note">
            No other machine is online. Open Hook on a computer and sign in to
            the same account, then try again.
          </p>
        ) : (
          <>
            <span className="remote-label">Machine</span>
            <div className="remote-machines" role="listbox" aria-label="Machine">
              {machines.map((entry) => (
                <button
                  key={entry.id}
                  className="remote-machine"
                  role="option"
                  aria-selected={entry.id === machineId}
                  data-active={entry.id === machineId}
                  onClick={() => setMachineId(entry.id)}
                >
                  <span className="machine-dot" data-online="true" />
                  <span className="remote-machine-copy">
                    <strong>{entry.name}</strong>
                    <em>
                      {[entry.platform, entry.kind === "headless" ? "headless" : null]
                        .filter(Boolean)
                        .join(" · ") || "computer"}
                    </em>
                  </span>
                  {entry.id === machineId && <Check strokeWidth={2.2} />}
                </button>
              ))}
            </div>

            <div className="remote-project-head">
              <span className="remote-label">
                {mode === "folder" ? "Folder" : "Project"}
              </span>
              <div className="remote-head-links">
                {mode === "folder" ? (
                  <button
                    type="button"
                    className="remote-link"
                    onClick={() => {
                      setMode("project");
                      setError(null);
                    }}
                  >
                    Projects
                  </button>
                ) : null}
                {loadFolders && mode === "project" ? (
                  <button
                    type="button"
                    className="remote-link"
                    onClick={() => {
                      setMode("folder");
                      setCreating(false);
                      setError(null);
                    }}
                  >
                    Browse folders…
                  </button>
                ) : null}
                {createProject && !creating && mode === "project" ? (
                  <button
                    type="button"
                    className="remote-link"
                    onClick={() => {
                      setCreating(true);
                      setError(null);
                    }}
                  >
                    New project
                  </button>
                ) : null}
              </div>
            </div>
            {mode === "folder" ? (
              <div className="remote-browser">
                <div className="remote-path">
                  <button
                    type="button"
                    className="remote-up"
                    // A drive root has no parent, so up from there means the
                    // places list — which is where the starred folders are.
                    disabled={!listing?.path || folderLoading}
                    title={listing?.parent ? "Up one level" : "Back to places"}
                    onClick={() => setFolder(listing?.parent ?? null)}
                  >
                    <ArrowUp strokeWidth={2} />
                  </button>
                  <span
                    className="remote-path-text"
                    title={listing?.path ?? undefined}
                  >
                    {listing?.path ?? "Places"}
                  </span>
                  {pinFolder && listing?.path ? (
                    <button
                      type="button"
                      className="remote-star"
                      data-on={isPinnedPath(pinned, listing.path)}
                      disabled={pinBusy === listing.path}
                      title={
                        isPinnedPath(pinned, listing.path)
                          ? "Unpin this folder on the machine"
                          : "Pin this folder on the machine"
                      }
                      aria-label={
                        isPinnedPath(pinned, listing.path)
                          ? "Unpin this folder"
                          : "Pin this folder"
                      }
                      aria-pressed={isPinnedPath(pinned, listing.path)}
                      onClick={() => void togglePin(listing.path ?? "")}
                    >
                      <StarMark on={isPinnedPath(pinned, listing.path)} />
                    </button>
                  ) : null}
                </div>
                {folderLoading && !listing ? (
                  <p className="remote-note">
                    Reading folders on {machine?.name}…
                  </p>
                ) : listing && listing.entries.length ? (
                  <div
                    className="remote-projects"
                    role="listbox"
                    aria-label="Folder"
                  >
                    {atTop && pinnedRows.length ? (
                      <span className="remote-group">Pinned</span>
                    ) : null}
                    {pinnedRows.map((entry) => (
                      <FolderRow
                        key={`pinned-${entry.path}`}
                        entry={entry}
                        pinned={true}
                        busy={pinBusy === entry.path}
                        onPin={pinFolder ? togglePin : undefined}
                        onOpen={(path) => setFolder(path)}
                      />
                    ))}
                    {atTop && pinnedRows.length && placeRows.length ? (
                      <span className="remote-group">Places</span>
                    ) : null}
                    {placeRows.map((entry) => (
                      <FolderRow
                        key={entry.path}
                        entry={entry}
                        pinned={isPinnedPath(pinned, entry.path)}
                        busy={pinBusy === entry.path}
                        onPin={pinFolder ? togglePin : undefined}
                        onOpen={(path) => setFolder(path)}
                      />
                    ))}
                  </div>
                ) : listing ? (
                  <p className="remote-note">
                    This folder has no folders inside it. Start here anyway, or
                    go back up.
                  </p>
                ) : null}
                {listing?.truncated ? (
                  <p className="remote-note">
                    Only the first {listing.entries.length} folders are shown.
                  </p>
                ) : null}
              </div>
            ) : creating ? (
              <div className="remote-project-form">
                <input
                  className="remote-input"
                  autoFocus
                  value={newName}
                  maxLength={64}
                  placeholder="project-name"
                  spellCheck={false}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void create();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setCreating(false);
                    }
                  }}
                />
                <input
                  className="remote-input"
                  value={newDescription}
                  maxLength={200}
                  placeholder="What belongs in it? (optional)"
                  onChange={(event) => setNewDescription(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void create();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setCreating(false);
                    }
                  }}
                />
                <div className="remote-project-form-actions">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!newName.trim() || projectBusy}
                    onClick={() => void create()}
                  >
                    {projectBusy ? "Creating…" : "Create project"}
                  </button>
                </div>
              </div>
            ) : loading ? (
              <p className="remote-note">Reading projects on {machine?.name}…</p>
            ) : projects && projects.length ? (
              <div className="remote-projects" role="listbox" aria-label="Project">
                {projects.map((entry) => (
                  <button
                    key={entry.project}
                    className="remote-project"
                    role="option"
                    aria-selected={entry.project === project}
                    data-active={entry.project === project}
                    onClick={() => setProject(entry.project)}
                  >
                    <span>
                      <strong>{entry.project}</strong>
                      {entry.description ? <em>{entry.description}</em> : null}
                    </span>
                    {entry.git ? <span className="remote-git">git</span> : null}
                  </button>
                ))}
              </div>
            ) : projects ? (
              <p className="remote-note">
                That machine has no projects yet.
                {createProject
                  ? " Create one here, or add one on the machine itself."
                  : " Add one there first, or use Coding agent… on the computer itself."}
              </p>
            ) : null}
          </>
        )}

        {error ? <p className="report-error">{error}</p> : null}

        <div className="remote-actions">
          <button className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!machineId || !target || busy}
            onClick={() => void start()}
          >
            {busy
              ? "Starting…"
              : mode === "folder"
                ? "Start in this folder"
                : "Start chat"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "That did not work.";
}

/**
 * One folder in the picker: the row that walks into it, and the star that makes
 * it a shortcut on the host. The star is a sibling of the row rather than a
 * child, because a button inside a button is not a control a browser can
 * deliver.
 */
function FolderRow({
  entry,
  pinned,
  busy,
  onPin,
  onOpen,
}: {
  entry: RemoteFolderOption;
  pinned: boolean;
  busy: boolean;
  onPin?: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <div className="remote-folder-line">
      <button
        type="button"
        className="remote-project remote-folder"
        role="option"
        aria-selected={false}
        onClick={() => onOpen(entry.path)}
      >
        <span>
          <strong>{entry.name}</strong>
        </span>
        <ChevronRight strokeWidth={1.8} />
      </button>
      {onPin ? (
        <button
          type="button"
          className="remote-pin"
          data-on={pinned}
          disabled={busy}
          title={pinned ? "Unpin this folder" : "Pin this folder"}
          aria-label={`${pinned ? "Unpin" : "Pin"} ${entry.name}`}
          aria-pressed={pinned}
          onClick={() => onPin(entry.path)}
        >
          <StarMark on={pinned} />
        </button>
      ) : null}
    </div>
  );
}

function StarMark({ on }: { on: boolean }) {
  return <Star strokeWidth={1.8} fill={on ? "currentColor" : "none"} />;
}

/** Two paths from one host name the same folder. Its paths are case
 * insensitive on Windows, and its own answers are the only source of them. */
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isPinnedPath(pinned: string[], path: string): boolean {
  return pinned.some((entry) => samePath(entry, path));
}

/** The last part of a path, for a star the picker learned about after the
 * listing was read. */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
