import { useEffect } from "react";
import { FolderOpen, GitBranch, LogOut, UserRound, X } from "lucide-react";

import { api, openExternal } from "../lib/bridge";
import { useChatStore } from "../store/useChatStore";

export function SettingsSheet() {
  const open = useChatStore((s) => s.settingsOpen);
  const close = useChatStore((s) => s.closeSettings);
  const settings = useChatStore((s) => s.settings);
  const chooseProjectsDir = useChatStore((s) => s.chooseProjectsDir);
  const auth = useChatStore((s) => s.auth);
  const authBusy = useChatStore((s) => s.authBusy);
  const signOut = useChatStore((s) => s.signOut);

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

          <p className="sheet-foot">
            Hook talks to its own account service; provider settings live on
            the server, not in this window.
          </p>
        </div>
      </div>
    </div>
  );
}
