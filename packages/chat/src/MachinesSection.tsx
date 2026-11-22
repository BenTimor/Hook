import { useState } from "react";
import {
  Check,
  Laptop,
  Pencil,
  Server,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";

import "./chat.css";

/** One machine the account knows, as `devices_list` returns it. */
export interface Machine {
  id: string;
  name: string;
  kind: string;
  platform?: string | null;
  arch?: string | null;
  appVersion?: string | null;
  canHost: boolean;
  online: boolean;
  hostOnline: boolean;
  role?: string;
  remoteAllowed: boolean;
  lastSeen?: string | null;
  specs?: { cpuCores?: number; projects?: number } | null;
}

export interface MachinesSectionProps {
  machines: Machine[];
  selfId: string;
  state: "signedOut" | "connecting" | "online" | "refused" | "offline" | string;
  message?: string | null;
  onRename?: (id: string, name: string) => Promise<void> | void;
  onSetRemote?: (id: string, allowed: boolean) => Promise<void> | void;
  onRemove?: (id: string) => Promise<void> | void;
}

function kindLabel(kind: string): string {
  if (kind === "headless") return "Cloud machine";
  if (kind === "mobile") return "Phone";
  return "Computer";
}

function KindIcon({ kind }: { kind: string }) {
  const props = { size: 18, strokeWidth: 1.8, "aria-hidden": true } as const;
  if (kind === "headless") return <Server {...props} />;
  if (kind === "mobile") return <Smartphone {...props} />;
  return <Laptop {...props} />;
}

function seenLabel(iso: string | null | undefined): string {
  if (!iso) return "seen before";
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "seen before";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 2) return "seen just now";
  if (minutes < 60) return `seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `seen ${hours}h ago`;
  return `seen ${Math.round(hours / 24)}d ago`;
}

function failure(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/**
 * The account's machines, shared by Hook and HookCode.
 *
 * It draws only; the parent supplies the actions and the surrounding settings
 * section. A machine Hook is not running on is still listed, with the last time
 * it was seen, so the list never pretends a computer is available when it is
 * not. "This computer" is the one the window is running on, not necessarily a
 * host — Workspace and the phone are controllers.
 */
export function MachinesSection({
  machines,
  selfId,
  state,
  message,
  onRename,
  onSetRemote,
  onRemove,
}: MachinesSectionProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state === "refused") {
    return (
      <p className="machine-note">
        {message ||
          "Running work on your other machines is part of a paid plan."}
      </p>
    );
  }
  if (state === "signedOut") {
    return <p className="machine-note">Sign in to see your machines.</p>;
  }
  if (!machines.length) {
    return (
      <p className="machine-note">
        {state === "connecting"
          ? "Connecting to your account…"
          : state === "offline"
            ? "Hook is offline. Your machines will appear when it reconnects."
            : "No machines yet. Hook on another computer appears here while it is running."}
      </p>
    );
  }

  async function save(id: string) {
    const name = draft.trim();
    if (!onRename || !name) return;
    setBusy(id);
    setError(null);
    try {
      await onRename(id, name);
      setEditing(null);
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(machine: Machine) {
    if (!onSetRemote) return;
    setBusy(machine.id);
    setError(null);
    try {
      await onSetRemote(machine.id, !machine.remoteAllowed);
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setBusy(null);
    }
  }

  async function remove(machine: Machine) {
    if (!onRemove) return;
    const ok = window.confirm(
      `Remove ${machine.name}? It will be signed out of this account on that machine.`,
    );
    if (!ok) return;
    setBusy(machine.id);
    setError(null);
    try {
      await onRemove(machine.id);
    } catch (problem) {
      setError(failure(problem));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="machines">
      <ul className="machine-list">
        {machines.map((machine) => {
          const self = machine.id === selfId;
          const working = busy === machine.id;
          return (
            <li
              className="machine-row"
              key={machine.id}
              data-online={machine.online}
            >
              <span className="machine-icon" aria-hidden="true">
                <KindIcon kind={machine.kind} />
              </span>
              <div className="machine-copy">
                {editing === machine.id ? (
                  <form
                    className="machine-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save(machine.id);
                    }}
                  >
                    <input
                      autoFocus
                      value={draft}
                      maxLength={60}
                      onChange={(event) => setDraft(event.target.value)}
                      aria-label="Machine name"
                    />
                    <button
                      className="machine-btn"
                      type="submit"
                      title="Save name"
                      disabled={working}
                    >
                      <Check size={15} strokeWidth={2} />
                    </button>
                    <button
                      className="machine-btn"
                      type="button"
                      title="Cancel"
                      onClick={() => setEditing(null)}
                    >
                      <X size={15} strokeWidth={2} />
                    </button>
                  </form>
                ) : (
                  <div className="machine-name">
                    <span>{machine.name}</span>
                    {self && <span className="machine-badge">This computer</span>}
                    {machine.canHost && (
                      <span className="machine-badge" data-host="true">
                        Runs agents
                      </span>
                    )}
                  </div>
                )}
                <div className="machine-meta">
                  <span>{kindLabel(machine.kind)}</span>
                  {machine.platform && <span>{machine.platform}</span>}
                  {machine.appVersion && <span>v{machine.appVersion}</span>}
                  {machine.specs?.cpuCores ? (
                    <span>{machine.specs.cpuCores} cores</span>
                  ) : null}
                  {machine.specs?.projects ? (
                    <span>{machine.specs.projects} projects</span>
                  ) : null}
                </div>
                <div className="machine-status">
                  <span
                    className="machine-dot"
                    data-online={machine.online}
                    aria-hidden="true"
                  />
                  {machine.hostOnline
                    ? "Online · ready for work"
                    : machine.online
                      ? "Online · cannot run agents"
                      : seenLabel(machine.lastSeen)}
                </div>
              </div>
              <div className="machine-actions">
                {editing !== machine.id && onRename && (
                  <button
                    className="machine-btn"
                    title="Rename this machine"
                    disabled={working}
                    onClick={() => {
                      setEditing(machine.id);
                      setDraft(machine.name);
                      setError(null);
                    }}
                  >
                    <Pencil size={15} strokeWidth={1.9} />
                  </button>
                )}
                {onRemove && !self && (
                  <button
                    className="machine-btn"
                    title="Remove this machine"
                    disabled={working}
                    onClick={() => void remove(machine)}
                  >
                    <Trash2 size={15} strokeWidth={1.9} />
                  </button>
                )}
              </div>
              {machine.canHost && onSetRemote && (
                <label className="machine-toggle">
                  <input
                    type="checkbox"
                    checked={machine.remoteAllowed}
                    disabled={working}
                    onChange={() => void toggle(machine)}
                  />
                  Accept remote work
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="machine-error">{error}</p>}
      {state === "offline" && (
        <p className="machine-note">
          Offline — showing the last known state. Hook will reconnect on its own.
        </p>
      )}
    </div>
  );
}
