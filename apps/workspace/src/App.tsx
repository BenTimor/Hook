import { useEffect, useState } from "react";
import {
  FolderKanban,
  Mail,
  PanelRight,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { HookMark, WindowControls, useWindowState } from "@hook/ui";

import { api, onAuthEvent, openExternal, type AuthView } from "./lib/bridge";

type View = "projects" | "invites";

export default function App() {
  const maximized = useWindowState();
  const [auth, setAuth] = useState<AuthView | null>(null);
  const [view, setView] = useState<View>("projects");
  const [dockOpen, setDockOpen] = useState(false);

  useEffect(() => {
    void api.authStatus().then(setAuth);
    return onAuthEvent(setAuth);
  }, []);

  if (!auth) {
    return <div className="shell" data-maximized={maximized} aria-busy="true" />;
  }

  if (!auth.signedIn) {
    return (
      <div className="shell" data-maximized={maximized}>
        <header className="ws-drag" data-tauri-drag-region>
          <span className="ws-drag-title">Hook Workspace</span>
          <WindowControls />
        </header>
        <main className="ws-signin">
          <div className="ws-signin-card">
            <HookMark className="ws-signin-mark" />
            <h1>Hook Workspace</h1>
            <p>
              Projects, boards, tasks and documents — shared with the same
              account as Hook, and synced between your computers.
            </p>

            {auth.state === "pending" && auth.userCode ? (
              <>
                <div className="ws-code">{auth.userCode}</div>
                <p className="ws-hint">
                  Enter this code in the browser window that just opened.
                </p>
                <div className="ws-signin-actions">
                  {auth.verificationUrl ? (
                    <button
                      className="btn btn-ghost"
                      onClick={() => void openExternal(auth.verificationUrl!)}
                    >
                      Open the page again
                    </button>
                  ) : null}
                  <button
                    className="btn btn-ghost"
                    onClick={() => void api.authCancelLogin().then(setAuth)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void api.authLogin().then(setAuth)}
              >
                Sign in with your Hook account
              </button>
            )}

            {auth.message ? <p className="ws-hint">{auth.message}</p> : null}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="shell" data-maximized={maximized}>
      <aside className="ws-rail" data-tauri-drag-region>
        <div className="ws-wordmark">
          <HookMark />
          <span>Workspace</span>
        </div>

        <nav className="ws-nav">
          <button
            className="ws-nav-row"
            data-active={view === "projects"}
            onClick={() => setView("projects")}
          >
            <FolderKanban />
            Projects
          </button>
          <button
            className="ws-nav-row"
            data-active={view === "invites"}
            onClick={() => setView("invites")}
          >
            <Mail />
            Invites
          </button>
        </nav>

        <div className="ws-rail-foot">
          <button className="ws-nav-row" onClick={() => void api.authLogout().then(setAuth)}>
            <Settings />
            <span className="ws-account" title={auth.email ?? undefined}>
              {auth.email}
            </span>
          </button>
        </div>
      </aside>

      <main className="ws-pane" data-dock={dockOpen}>
        <header className="ws-head" data-tauri-drag-region>
          <div className="ws-head-left" data-tauri-drag-region>
            <span className="ws-crumb">
              {view === "projects" ? "Projects" : "Invites"}
            </span>
          </div>
          <div className="ws-head-right">
            <button
              className="icon-btn"
              title={dockOpen ? "Hide Hook" : "Ask Hook"}
              aria-label={dockOpen ? "Hide Hook" : "Ask Hook"}
              onClick={() => setDockOpen((open) => !open)}
            >
              <PanelRight />
            </button>
            <WindowControls />
          </div>
        </header>

        <div className="ws-body">
          {view === "projects" ? (
            <section className="ws-empty">
              <h2>No projects yet</h2>
              <p>
                A project holds its own boards, documents and people. Create one
                here, or ask Hook in the panel to set it up for you.
              </p>
              <button className="btn" disabled title="Arrives with the workspace API">
                <Plus />
                New project
              </button>
            </section>
          ) : (
            <section className="ws-empty">
              <h2>No invitations</h2>
              <p>When someone invites you to a project, it appears here.</p>
            </section>
          )}
        </div>
      </main>

      {dockOpen ? (
        <aside className="ws-dock">
          <header className="ws-dock-head" data-tauri-drag-region>
            <HookMark />
            <span>Hook</span>
            <button
              className="icon-btn"
              title="Hide Hook"
              aria-label="Hide Hook"
              onClick={() => setDockOpen(false)}
            >
              <X />
            </button>
          </header>
          <div className="ws-dock-body">
            <p className="ws-dock-note">
              The chat lands here: the same conversations as Hook, with the
              project you are looking at as context.
            </p>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
