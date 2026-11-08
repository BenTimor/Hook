import { useEffect, useState } from "react";
import { Check, FolderOpen, GitBranch, X } from "lucide-react";

import { api } from "../lib/bridge";
import { useChatStore } from "../store/useChatStore";

export function SettingsSheet() {
  const open = useChatStore((s) => s.settingsOpen);
  const close = useChatStore((s) => s.closeSettings);
  const settings = useChatStore((s) => s.settings);
  const chooseProjectsDir = useChatStore((s) => s.chooseProjectsDir);
  const setPiCommand = useChatStore((s) => s.setPiCommand);

  const [piDraft, setPiDraft] = useState("");
  const [savingPi, setSavingPi] = useState(false);

  useEffect(() => {
    if (settings) setPiDraft(settings.piCommand ?? "");
  }, [settings]);

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

  const piReady = Boolean(settings?.piCommand);

  const savePi = async () => {
    setSavingPi(true);
    await setPiCommand(piDraft.trim() || null);
    setSavingPi(false);
  };

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
              <span>Coding agent</span>
              <span className={`status ${piReady ? "ok" : "bad"}`}>
                {piReady ? (
                  <>
                    <Check strokeWidth={2.6} /> Ready
                  </>
                ) : (
                  "Not found"
                )}
              </span>
            </div>
            <p className="sheet-help">
              Coding agents run pi inside a project folder, isolated from your own pi
              setup. Point Hook at the pi executable if it is not on PATH.
            </p>
            <div className="path-row">
              <input
                className="text-input"
                value={piDraft}
                spellCheck={false}
                placeholder="C:\path\to\pi.cmd"
                onChange={(event) => setPiDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void savePi();
                }}
              />
              <button className="btn" disabled={savingPi} onClick={() => void savePi()}>
                Save
              </button>
              {settings?.piDetected && settings.piDetected !== piDraft && (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setPiDraft(settings.piDetected ?? "");
                    void setPiCommand(settings.piDetected ?? null);
                  }}
                >
                  Use detected
                </button>
              )}
            </div>
          </section>

          <p className="sheet-foot">
            Provider settings are compiled into this build — edit{" "}
            <code>harness.config.toml</code> and rebuild Hook to change them.
          </p>
        </div>
      </div>
    </div>
  );
}
