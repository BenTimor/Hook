import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Mail,
  PanelRight,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { HookMark, TextFieldDialog, WindowControls, useWindowState } from "@hook/ui";
import { ChatDock } from "@hook/chat";

import { api, onAuthEvent, openExternal, type AuthView } from "./lib/bridge";
import { chatTransport, setChatContext } from "./lib/chatTransport";
import type { DocumentMeta } from "./lib/types";
import { useWorkspaceStore } from "./store/useWorkspaceStore";
import { BoardView, TaskPanel } from "./components/BoardView";
import { DocumentEditor } from "./components/DocumentEditor";
import { InvitesPanel } from "./components/MembersPanel";
import { ProjectHome } from "./components/ProjectHome";

export default function App() {
  const maximized = useWindowState();
  const [auth, setAuth] = useState<AuthView | null>(null);

  useEffect(() => {
    void api.authStatus().then(setAuth);
    return onAuthEvent(setAuth);
  }, []);

  if (!auth) {
    return <div className="shell" data-maximized={maximized} aria-busy="true" />;
  }
  if (!auth.signedIn) {
    return <SignIn auth={auth} setAuth={setAuth} maximized={maximized} />;
  }
  return <Workspace auth={auth} setAuth={setAuth} maximized={maximized} />;
}

function Workspace({
  auth,
  setAuth,
  maximized,
}: {
  auth: AuthView;
  setAuth: (view: AuthView) => void;
  maximized: boolean;
}) {
  const bootstrap = useWorkspaceStore((state) => state.bootstrap);
  const projects = useWorkspaceStore((state) => state.projects);
  const invites = useWorkspaceStore((state) => state.invites);
  const error = useWorkspaceStore((state) => state.error);
  const dismissError = useWorkspaceStore((state) => state.dismissError);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeBoardId = useWorkspaceStore((state) => state.activeBoardId);
  const activeTaskId = useWorkspaceStore((state) => state.activeTaskId);
  const activeDocumentId = useWorkspaceStore((state) => state.activeDocumentId);
  const boards = useWorkspaceStore((state) =>
    state.activeProjectId ? (state.boards[state.activeProjectId] ?? EMPTY) : EMPTY,
  );
  const tasks = useWorkspaceStore((state) =>
    state.activeBoardId ? (state.tasks[state.activeBoardId] ?? EMPTY) : EMPTY,
  );
  const openProject = useWorkspaceStore((state) => state.openProject);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const openDocument = useWorkspaceStore((state) => state.openDocument);
  const createProject = useWorkspaceStore((state) => state.createProject);

  const [view, setView] = useState<"projects" | "invites">("projects");
  const [dockOpen, setDockOpen] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [projectName, setProjectName] = useState("");

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const board = useMemo(
    () => boards.find((candidate) => candidate.id === activeBoardId) ?? null,
    [boards, activeBoardId],
  );
  const task = useMemo(
    () => tasks.find((candidate) => candidate.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  // The chat agent should know what "this" is. While the dock is open the
  // summary is refreshed on a slow tick, because a text selection is not a
  // React event; a string compare in Rust makes repeats free.
  useEffect(() => {
    if (!dockOpen) {
      void setChatContext("");
      return;
    }
    const push = () => {
      const lines: string[] = [];
      if (project) lines.push(`Project: ${project.name}`);
      if (board) lines.push(`Board: ${board.name}`);
      if (task) lines.push(`Open task: ${task.title}`);
      if (activeDocumentId) lines.push("A document is open in the editor.");
      const selection = window.getSelection()?.toString().trim();
      if (selection) lines.push(`Selected text: "${selection.slice(0, 800)}"`);
      void setChatContext(lines.join("\n"));
    };
    push();
    const timer = window.setInterval(push, 1500);
    return () => window.clearInterval(timer);
  }, [dockOpen, project, board, task, activeDocumentId]);


  return (
    <div className="shell" data-maximized={maximized}>
      <aside className="ws-rail" data-tauri-drag-region>
        <div className="ws-wordmark">
          <HookMark />
          <span>Workspace</span>
        </div>

        <button
          className="ws-new"
          onClick={() => {
            setView("projects");
            setNewProject(true);
          }}
        >
          <Plus strokeWidth={1.9} />
          New project
        </button>

        <nav className="ws-nav">
          {projects.map((entry) => (
            <button
              key={entry.id}
              className="ws-nav-row"
              data-active={entry.id === activeProjectId && view === "projects"}
              onClick={() => {
                setView("projects");
                void openProject(entry.id);
              }}
              title={entry.name}
            >
              <span className="ws-project-dot" aria-hidden="true" />
              <span className="ws-nav-label">{entry.name}</span>
            </button>
          ))}
        </nav>

        <div className="ws-rail-foot">
          <button
            className="ws-nav-row"
            data-active={view === "invites"}
            onClick={() => setView("invites")}
          >
            <Mail />
            <span className="ws-nav-label">Invites</span>
            {invites.length > 0 && <span className="ws-badge">{invites.length}</span>}
          </button>
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
            {project && view === "projects" ? (
              <button
                className="icon-btn"
                title="Back to projects"
                onClick={() => {
                  void openBoard(null);
                  void openDocument(null);
                }}
              >
                <ArrowLeft strokeWidth={1.8} />
              </button>
            ) : null}
            <span className="ws-crumb">
              {view === "invites"
                ? "Invites"
                : board
                  ? `${project?.name ?? ""} / ${board.name}`
                  : activeDocumentId
                    ? `${project?.name ?? ""} / document`
                    : (project?.name ?? "Projects")}
            </span>
          </div>
          <div className="ws-head-right">
            {project && !board && !activeDocumentId && view === "projects" && (
              <button
                className="btn btn-ghost"
                onClick={() => void openProject(project.id)}
                title="Refresh"
              >
                Refresh
              </button>
            )}
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

        {error ? (
          <div className="ws-error" role="alert">
            <span>{error}</span>
            <button className="icon-btn" onClick={dismissError} aria-label="Dismiss">
              <X strokeWidth={1.9} />
            </button>
          </div>
        ) : null}

        <div className="ws-body">
          {view === "invites" ? (
            <InvitesPanel />
          ) : !project ? (
            <section className="ws-empty">
              <h2>No project open</h2>
              <p>
                Pick a project on the left, or create one. Every project has its
                own boards, documents and people.
              </p>
              <button className="btn btn-primary" onClick={() => setNewProject(true)}>
                <Plus /> New project
              </button>
            </section>
          ) : activeDocumentId ? (
            <DocumentPage
              id={activeDocumentId}
              project={project}
              onBack={() => void openDocument(null)}
            />
          ) : board ? (
            <BoardView board={board} tasks={tasks} />
          ) : (
            <ProjectHome
              project={project}
              onOpenBoard={(id) => {
                void openBoard(id);
                void openDocument(null);
              }}
              onOpenDocument={(id) => void openDocument(id)}
            />
          )}
        </div>

      </main>

      {task ? <TaskPanel task={task} /> : null}

      <ChatDock
        transport={chatTransport}
        open={dockOpen}
        onClose={() => setDockOpen(false)}
      />

      <TextFieldDialog
        open={newProject}
        title="New project"
        description="A project holds boards, documents and the people you share them with."
        label="Project name"
        placeholder="Website redesign"
        value={projectName}
        onChange={setProjectName}
        confirm="Create project"
        onClose={() => setNewProject(false)}
        onConfirm={() => {
          const name = projectName.trim();
          if (!name) return;
          void createProject(name);
          setProjectName("");
          setNewProject(false);
          setView("projects");
        }}
      />
    </div>
  );
}

type Project = ReturnType<typeof useWorkspaceStore.getState>["projects"][number];

const EMPTY: never[] = [];


/** A document: title, raw toggle, save state, and the conflict choice. */
function DocumentPage({
  id,
  project,
  onBack,
}: {
  id: string;
  project: Project;
  onBack: () => void;
}) {
  const loadDocument = useWorkspaceStore((state) => state.loadDocument);
  const saveDocument = useWorkspaceStore((state) => state.saveDocument);
  const deleteDocument = useWorkspaceStore((state) => state.deleteDocument);

  const [loaded, setLoaded] = useState<DocumentMeta | null>(null);
  const [raw, setRaw] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<DocumentMeta | null>(null);
  const [title, setTitle] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [forceSave, setForceSave] = useState(0);

  // The revision every write is based on. It moves forward on each accepted
  // save, and jumps when the user chooses to keep their text over someone
  // else's version.
  const baseRev = useRef(0);

  useEffect(() => {
    let alive = true;
    void loadDocument(id).then((document) => {
      if (!alive || !document) return;
      baseRev.current = document.rev;
      setLoaded(document);
      setTitle(document.title);
    });
    return () => {
      alive = false;
    };
  }, [id, loadDocument]);

  if (!loaded) {
    return <section className="ws-empty">Opening…</section>;
  }

  const readOnly = project.role === "viewer";

  return (
    <div className="ws-document">
      <div className="ws-document-bar">
        <input
          className="ws-document-title"
          value={title}
          readOnly={readOnly}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (title.trim() && title !== loaded.title) {
              void saveDocument(id, { title: title.trim() });
            }
          }}
        />
        <span className="ws-document-state" data-dirty={dirty}>
          {dirty ? "Saving…" : `Saved · revision ${baseRev.current}`}
        </span>
        <button
          className="btn btn-ghost"
          data-active={raw}
          onClick={() => setRaw((value) => !value)}
          title="Show the Markdown as it is stored"
        >
          {raw ? "Preview" : "Raw"}
        </button>
        <button className="btn btn-ghost" onClick={onBack}>
          Close
        </button>
        {project.role !== "viewer" && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              if (confirm("Delete this document for everyone?")) {
                void deleteDocument(id).then(onBack);
              }
            }}
          >
            Delete
          </button>
        )}
      </div>

      {conflict ? (
        <div className="ws-conflict" role="alert">
          <span>
            Someone else edited this document while you were writing. Your text
            is still in the editor.
          </span>
          <button
            className="btn"
            onClick={() => {
              baseRev.current = conflict.rev;
              setLoaded(conflict);
              setConflict(null);
              setDirty(false);
              setEpoch((value) => value + 1);
            }}
          >
            Load theirs
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              // Keep mine: write over the fresh revision deliberately.
              baseRev.current = conflict.rev;
              setLoaded({ ...loaded, rev: conflict.rev });
              setConflict(null);
              setForceSave((value) => value + 1);
            }}
          >
            Keep mine
          </button>
        </div>
      ) : null}

      <DocumentEditor
        key={`${id}-${epoch}`}
        document={loaded}
        raw={raw}
        readOnly={readOnly}
        forceSave={forceSave}
        onChange={setDirty}
        onSave={async (markdown) => {
          const result = await saveDocument(id, { markdown, baseRev: baseRev.current });
          if (result.conflict) {
            setConflict(result.conflict);
            return false;
          }
          if (result.document) {
            baseRev.current = result.document.rev;
            setLoaded((current) => (current ? { ...current, rev: result.document!.rev } : current));
            return true;
          }
          return false;
        }}
      />
    </div>
  );
}

function SignIn({
  auth,
  setAuth,
  maximized,
}: {
  auth: AuthView;
  setAuth: (view: AuthView) => void;
  maximized: boolean;
}) {
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
            Projects, boards, tasks and documents — shared with the same account
            as Hook, and synced between your computers.
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
            <button className="btn btn-primary" onClick={() => void api.authLogin().then(setAuth)}>
              Sign in with your Hook account
            </button>
          )}

          {auth.message ? <p className="ws-hint">{auth.message}</p> : null}
        </div>
      </main>
    </div>
  );
}
