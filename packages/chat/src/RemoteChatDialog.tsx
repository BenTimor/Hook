import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Monitor, X } from "lucide-react";

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

/**
 * Choosing where a direct coding chat lives.
 *
 * The conversation is created on the host, next to its folder and engine; this
 * window only keeps a cache. That is why the picker never asks for a path: it
 * offers the projects the host already knows, and the host resolves the folder.
 * Shared by the desktop window and the phone so both ask the same question.
 */
export function RemoteChatDialog({
  devices,
  selfId,
  onClose,
  loadProjects,
  createProject,
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
  onCreate: (deviceId: string, project: string) => Promise<void>;
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
    if (!machineId || !project || busy || creating || projectBusy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(machineId, project);
      onClose();
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const machine = machines.find((entry) => entry.id === machineId);

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
              <span className="remote-label">Project</span>
              {createProject && !creating ? (
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
            {creating ? (
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
            disabled={!machineId || !project || busy}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Start chat"}
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
