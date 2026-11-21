import { useEffect, useState } from "react";
import {
  ArrowUpCircle,
  Cloud,
  FolderOpen,
  GitBranch,
  LogOut,
  RefreshCw,
  UserRound,
  X,
} from "lucide-react";

import { api, openExternal } from "../lib/bridge";
import type { SyncView } from "../lib/types";
import { useChatStore } from "../store/useChatStore";
import { useUpdateStore } from "../store/useUpdateStore";
import { ImportSection } from "./ImportSection";
import { MemorySection } from "./MemorySection";
import { AboutSection } from "./AboutSection";

/**
 * One quiet line about where the work lives. Syncing itself is automatic; this
 * is only here so a curious user (or support) can see that it is working.
 */
function SyncRow() {
  const [status, setStatus] = useState<SyncView | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void api
        .syncStatus()
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!status?.enabled) return null;
  const title =
    status.state === "syncing"
      ? "Saving your latest changes…"
      : status.state === "error"
        ? "Sync is paused"
        : "Saved to your account";
  return (
    <section className="sheet-section">
      <div className="sheet-label">
        <span>Sync</span>
      </div>
      <div className="account-row">
        <span className="account-badge" aria-hidden="true">
          <Cloud strokeWidth={1.8} />
        </span>
        <div className="account-identity">
          <strong>{title}</strong>
          <span>
            {status.message ??
              "Your chats and projects are available on every computer signed in to this account."}
          </span>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => void api.syncNow()}
          disabled={status.state === "syncing"}
          title="Sync now"
        >
          <RefreshCw strokeWidth={1.9} />
          Sync now
        </button>
      </div>
    </section>
  );
}

export function SettingsSheet() {
  const open = useChatStore((s) => s.settingsOpen);
  const close = useChatStore((s) => s.closeSettings);
  const settings = useChatStore((s) => s.settings);
  const chooseProjectsDir = useChatStore((s) => s.chooseProjectsDir);
  const setAdvancedMode = useChatStore((s) => s.setAdvancedMode);
  const auth = useChatStore((s) => s.auth);
  const authBusy = useChatStore((s) => s.authBusy);
  const signOut = useChatStore((s) => s.signOut);
  const version = useChatStore((s) => s.info?.version);
  const update = useUpdateStore((s) => s.info);
  const checking = useUpdateStore((s) => s.checking);
  const installing = useUpdateStore((s) => s.installing);
  const closing = useUpdateStore((s) => s.closing);
  const checkUpdate = useUpdateStore((s) => s.check);
  const installUpdate = useUpdateStore((s) => s.install);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="sheet-backdrop" onMouseDown={close}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={close} title="Close">
            <X strokeWidth={2} />
          </button>
        </div>

        <div className="sheet-body">
          <section className="sheet-section">
            <div className="sheet-label">
              <span>Account</span>
            </div>
            <div className="account-row">
              <span className="account-badge" aria-hidden="true">
                <UserRound strokeWidth={1.8} />
              </span>
              <div className="account-identity">
                <strong>{auth?.name || "Signed in"}</strong>
                <span>{auth?.email}</span>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => void signOut()}
                disabled={authBusy}
                title="Sign out"
              >
                <LogOut strokeWidth={1.9} />
                {authBusy ? "Signing out…" : "Sign out"}
              </button>
            </div>
            <p className="sheet-help">
              Chat and coding agents use this account.{" "}
              <button
                className="inline-link"
                onClick={() => void openExternal("https://hookcode.io/")}
              >
                Manage access on hookcode.io
              </button>
              .
            </p>
          </section>

          <ImportSection />

          <section className="sheet-section">
            <div className="sheet-label">
              <span>Advanced</span>
            </div>
            <label className="memory-note advanced-toggle">
              <input
                type="checkbox"
                checked={Boolean(settings?.advancedMode)}
                onChange={(event) => void setAdvancedMode(event.target.checked)}
              />
              Show thinking and tool calls
            </label>
            <p className="sheet-help">
              Every answer folds the model's thinking and the tools it ran into
              one block you can open again, and the sidebar lists the coding
              agents with a read-only view of what each one did. Off by default,
              because it is a lot of detail.
            </p>
          </section>

          <MemorySection />

          <SyncRow />

          <section className="sheet-section">
            <div className="sheet-label">
              <span>Projects folder</span>
            </div>
            <p className="sheet-help">
              Every project lives in one folder. Chats can create projects here and
              hand work to coding agents inside them.
            </p>
            <div className="path-row">
              <code className="path-box">{settings?.projectsDir ?? "…"}</code>
              <button className="btn" onClick={() => void chooseProjectsDir()}>
                Choose…
              </button>
              <button
                className="btn btn-ghost"
                title="Open in Explorer"
                onClick={() =>
                  settings && void api.openPath(settings.projectsDir)
                }
              >
                <FolderOpen strokeWidth={1.9} />
              </button>
            </div>

            {settings?.projects.length ? (
              <ul className="project-list">
                {settings.projects.map((project) => (
                  <li key={project.path}>
                    <div className="project-name">
                      {project.name}
                      {project.isGit && (
                        <span className="badge">
                          <GitBranch strokeWidth={2} />
                          git
                        </span>
                      )}
                    </div>
                    <div className="project-desc">
                      {project.description || (
                        <span className="muted">No description yet</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sheet-help muted">
                No projects yet. Ask for something and the chat agent will create one.
              </p>
            )}
          </section>

          <section className="sheet-section">
            <div className="sheet-label">
              <span>Updates</span>
            </div>
            <div className="update-settings-row">
              <div className="update-settings-copy">
                <strong>Hook {update?.current ?? version ?? "…"}</strong>
                <span>
                  {update
                    ? update.available
                      ? `Version ${update.latest} is available.`
                      : "You’re on the latest version."
                    : "Check whether a newer version is available."}
                </span>
              </div>
              {update?.available ? (
                <button
                  className="btn btn-primary"
                  onClick={() => void installUpdate()}
                  disabled={installing || closing}
                >
                  <ArrowUpCircle strokeWidth={1.9} />
                  {closing
                    ? "Closing Hook…"
                    : installing
                      ? "Updating…"
                      : update?.channel === "store"
                        ? "Close Hook and update"
                        : "Update now"}
                </button>
              ) : (
                <button
                  className="btn"
                  onClick={() => void checkUpdate()}
                  disabled={checking}
                >
                  <RefreshCw strokeWidth={1.9} className={checking ? "spin" : undefined} />
                  {checking ? "Checking…" : "Check for updates"}
                </button>
              )}
            </div>
            <p className="sheet-help">
              {update?.channel === "store"
                ? "Updates come from the Microsoft Store. Hook closes so the Store can replace it — reopen it when the Store finishes. Your chats and projects stay where they are."
                : "Updates install from inside Hook and restart it. Your chats and projects stay where they are."}
              {update && update.minimum !== "0.0.0" ? (
                <> Hook {update.minimum} is the oldest supported version.</>
              ) : null}
            </p>
          </section>

          <AboutSection version={update?.current ?? version} />

          <p className="sheet-foot">
            Hook talks to its own account service; provider settings live on
            the server, not in this window.
          </p>
        </div>
      </div>
    </div>
  );
}
