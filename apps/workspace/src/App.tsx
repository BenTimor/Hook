import { useEffect, useMemo, useRef, useState } from "react";
import { AlignLeft, AlignRight, ArrowLeft, Check, Code2, MessageCircleMore, MoreHorizontal, Trash2, X } from "lucide-react";
import { HookMark, TextFieldDialog, WindowControls, useWindowState } from "@hook/ui";
import { ChatDock } from "@hook/chat";

import { api, onAuthEvent, openExternal, type AuthView } from "./lib/bridge";
import { chatTransport, setChatContext } from "./lib/chatTransport";
import { rememberOpened } from "./lib/projectShortcuts";
import type { DocumentMeta, TextDirection } from "./lib/types";
import { useWorkspaceStore } from "./store/useWorkspaceStore";
import { BoardPage, TaskPanel } from "./components/BoardView";
import { DocumentEditor } from "./components/DocumentEditor";
import { InvitesPanel } from "./components/MembersPanel";
import { ProjectHome } from "./components/ProjectHome";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceHome } from "./components/WorkspaceHome";
import { WorkspaceSettings } from "./components/WorkspaceSettings";

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

const EMPTY: never[] = [];

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
  const error = useWorkspaceStore((state) => state.error);
  const dismissError = useWorkspaceStore((state) => state.dismissError);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeBoardId = useWorkspaceStore((state) => state.activeBoardId);
  const activeTaskId = useWorkspaceStore((state) => state.activeTaskId);
  const activeDocumentId = useWorkspaceStore((state) => state.activeDocumentId);
  const boards = useWorkspaceStore((state) =>
    state.activeProjectId ? (state.boards[state.activeProjectId] ?? EMPTY) : EMPTY,
  );
  const documents = useWorkspaceStore((state) =>
    state.activeProjectId ? (state.documents[state.activeProjectId] ?? EMPTY) : EMPTY,
  );
  const tasks = useWorkspaceStore((state) =>
    state.activeBoardId ? (state.tasks[state.activeBoardId] ?? EMPTY) : EMPTY,
  );
  const openProject = useWorkspaceStore((state) => state.openProject);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const openTask = useWorkspaceStore((state) => state.openTask);
  const openDocument = useWorkspaceStore((state) => state.openDocument);
  const createProject = useWorkspaceStore((state) => state.createProject);

  const [invitesOpen, setInvitesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const documentMeta = useMemo(
    () => documents.find((candidate) => candidate.id === activeDocumentId) ?? null,
    [documents, activeDocumentId],
  );
  const task = useMemo(
    () => tasks.find((candidate) => candidate.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  useEffect(() => {
    if (!activeProjectId) return;
    if (board && board.id === activeBoardId) rememberOpened(auth.email ?? null, activeProjectId, { kind: "board", id: board.id });
    else if (documentMeta && documentMeta.id === activeDocumentId) rememberOpened(auth.email ?? null, activeProjectId, { kind: "document", id: documentMeta.id });
  }, [auth.email, activeProjectId, activeBoardId, activeDocumentId, board, documentMeta]);

  // Picking something in the tree leaves the invites list behind.
  useEffect(() => {
    if (activeProjectId) setInvitesOpen(false);
  }, [activeProjectId, activeBoardId, activeDocumentId]);

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
      if (activeDocumentId) lines.push(`Document: ${documentMeta?.title || "Untitled"}`);
      const selection = window.getSelection()?.toString().trim();
      if (selection) lines.push(`Selected text: "${selection.slice(0, 800)}"`);
      void setChatContext(lines.join("\n"));
    };
    push();
    const timer = window.setInterval(push, 1500);
    return () => window.clearInterval(timer);
  }, [dockOpen, project, board, task, activeDocumentId, documentMeta]);

  const suggestions = board
    ? [
        "Plan the next tasks on this board",
        "Which task should I do first?",
        "Summarise what is on this board",
      ]
    : activeDocumentId
      ? [
          "Summarise this document",
          "Tighten this document's opening",
          "Turn this into a task list",
        ]
      : project ? [
          "Create a board for this project",
          "What should we work on next?",
          "Invite someone to this project",
        ] : [
          "Help me plan a new project",
          "Turn my idea into a task list",
          "What can I do in Workspace?",
        ];

  const crumbs: Array<{ label: string; onClick?: () => void }> = invitesOpen
    ? [{ label: "Invites" }]
    : project
      ? [
          { label: project.name, onClick: () => void openProject(project.id) },
          ...(board
            ? [{ label: board.name, ...(task ? { onClick: () => void openTask(null) } : {}) }, ...(task ? [{ label: task.title }] : [])]
            : documentMeta
              ? [{ label: documentMeta.title || "Untitled" }]
              : []),
        ]
      : [{ label: "Home" }];

  const back = Boolean(board || activeDocumentId);
  const showProject = (id: string) => {
    setInvitesOpen(false);
    void openProject(id);
  };
  const showInvites = () => {
    void openProject(null);
    setInvitesOpen(true);
  };

  return (
    <div className="shell" data-maximized={maximized}>
      <Sidebar
        email={auth.email ?? null}
        name={auth.name ?? null}
        homeActive={!project && !invitesOpen}
        invitesActive={invitesOpen}
        onHome={() => {
          setInvitesOpen(false);
          void openProject(null);
        }}
        onNewProject={() => {
          setInvitesOpen(false);
          setNewProject(true);
        }}
        onOpenInvites={showInvites}
        onSettings={() => setSettingsOpen(true)}
        onLogout={() => void api.authLogout().then(setAuth)}
      />

      <main className="ws-pane" data-dock={dockOpen}>
        <header className="ws-head" data-tauri-drag-region>
          <div className="ws-head-left" data-tauri-drag-region>
            {back && project ? (
              <button
                className="icon-btn ws-back"
                title={task ? "Back to the board" : "Back to the project"}
                aria-label={task ? "Back to the board" : "Back to the project"}
                onClick={() => task ? void openTask(null) : void openProject(project.id)}
              >
                <ArrowLeft strokeWidth={1.8} />
              </button>
            ) : null}
            <nav className="ws-crumbs" aria-label="Location">
              {crumbs.map((crumb, index) => (
                <span className="ws-crumb" key={`${crumb.label}-${index}`}>
                  {index > 0 ? <span className="ws-crumb-sep">/</span> : null}
                  {crumb.onClick ? (
                    <button className="ws-crumb-link" onClick={crumb.onClick} title={crumb.label}>
                      {crumb.label}
                    </button>
                  ) : (
                    <span className="ws-crumb-now" title={crumb.label}>
                      {crumb.label}
                    </span>
                  )}
                </span>
              ))}
            </nav>
          </div>
          <div className="ws-head-right">
            <button
              className="icon-btn"
              data-active={dockOpen}
              title={dockOpen ? "Hide Hook" : "Ask Hook"}
              aria-label={dockOpen ? "Hide Hook" : "Ask Hook"}
              aria-pressed={dockOpen}
              onClick={() => setDockOpen((open) => !open)}
            >
              <MessageCircleMore />
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
          {invitesOpen ? (
            <InvitesPanel onOpenProject={showProject} />
          ) : !project ? (
            <WorkspaceHome
              onNewProject={() => setNewProject(true)}
              onAskHook={() => setDockOpen(true)}
              onOpenProject={showProject}
              onOpenInvites={showInvites}
            />
          ) : activeDocumentId ? (
            <DocumentPage
              id={activeDocumentId}
              project={project}
              onBack={() => void openProject(project.id)}
            />
          ) : board ? (
            <>
              <div className="ws-board-container" hidden={Boolean(task)}><BoardPage board={board} tasks={tasks} /></div>
              {task && <TaskPanel key={task.id} task={task} accountEmail={auth.email ?? null} />}
            </>
          ) : (
            <ProjectHome
              key={`${auth.email ?? ""}:${project.id}`}
              project={project}
              accountEmail={auth.email ?? null}
              onOpenBoard={(id) => void openBoard(id, project.id)}
              onOpenDocument={(id) => void openDocument(id, project.id)}
            />
          )}
        </div>
      </main>

      <ChatDock
        transport={chatTransport}
        open={dockOpen}
        suggestions={suggestions}
        onClose={() => setDockOpen(false)}
      />

      <WorkspaceSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

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
          setInvitesOpen(false);
        }}
      />
    </div>
  );
}

type Project = ReturnType<typeof useWorkspaceStore.getState>["projects"][number];


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
  const [direction, setDirection] = useState<TextDirection>("ltr");
  const [epoch, setEpoch] = useState(0);
  const [forceSave, setForceSave] = useState(0);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  // A rename from the tree is a save like any other; follow it here too, unless
  // the title field is the thing being typed in.
  const meta = useWorkspaceStore((state) =>
    (state.documents[project.id] ?? EMPTY).find((candidate) => candidate.id === id),
  );

  // The revision every write is based on. It moves forward on each accepted
  // save, and jumps when the user chooses to keep their text over someone
  // else's version.
  const baseRev = useRef(0);

  useEffect(() => { setRaw(false); }, [id]);

  useEffect(() => {
    if (!optionsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOptionsOpen(false);
        optionsButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [optionsOpen]);

  useEffect(() => {
    let alive = true;
    void loadDocument(id).then((document) => {
      if (!alive || !document) return;
      baseRev.current = document.rev;
      setLoaded(document);
      setTitle(document.title);
      setDirection(document.direction === "rtl" ? "rtl" : "ltr");
    });
    return () => {
      alive = false;
    };
  }, [id, loadDocument]);

  useEffect(() => {
    if (!meta) return;
    if (document.activeElement?.classList.contains("ws-document-title")) return;
    setTitle(meta.title);
  }, [meta?.title]);

  useEffect(() => {
    if (!meta) return;
    setDirection(meta.direction === "rtl" ? "rtl" : "ltr");
  }, [meta?.direction]);

  if (!loaded) {
    return <section className="ws-empty">Opening…</section>;
  }

  const readOnly = project.role === "viewer";

  const changeDirection = (next: TextDirection) => {
    setDirection(next);
    setLoaded((current) => (current ? { ...current, direction: next } : current));
    setOptionsOpen(false);
    void saveDocument(id, { direction: next });
  };

  return (
    <div className="ws-document">
      <div className="ws-document-bar">
        <input
          className="ws-document-title"
          dir={direction}
          value={title}
          readOnly={readOnly}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (title.trim() && title !== loaded.title) {
              void saveDocument(id, { title: title.trim() });
            }
          }}
        />
        <span className="ws-document-state" data-dirty={dirty} title={dirty ? "Saving changes" : `Saved · revision ${baseRev.current}`} aria-live="polite">
          {!dirty && <Check aria-hidden="true" />}
          {dirty ? "Saving…" : "Saved"}
        </span>
        {raw && (
          <button type="button" className="ws-source-indicator" onClick={() => setRaw(false)} title="Return to the formatted document">
            <Code2 aria-hidden="true" /> <span>Markdown</span><span className="ws-source-return">Back to document</span>
          </button>
        )}
        <div className="ws-document-options" ref={optionsRef}>
          <button type="button" ref={optionsButton} className="ws-document-options-trigger" aria-label="Document options" aria-expanded={optionsOpen} aria-controls="document-options" onClick={() => setOptionsOpen((open) => !open)}>
            <MoreHorizontal aria-hidden="true" />
          </button>
          {optionsOpen && (
            <div className="ws-document-options-menu" id="document-options" aria-label="Document options">
              <div className="ws-document-options-heading">Document options</div>
              <button type="button" className="ws-document-option" onClick={() => { setRaw(!raw); setOptionsOpen(false); }}>
                <Code2 aria-hidden="true" />
                <span><strong>{raw ? "Back to document" : readOnly ? "View Markdown" : "Edit Markdown"}</strong><small>{raw ? "Return to the formatted document" : readOnly ? "View the source" : "View and edit the source"}</small></span>
              </button>
              <div className="ws-document-options-heading">Text direction</div>
              <button
                type="button"
                className="ws-document-option"
                data-active={direction === "ltr"}
                aria-pressed={direction === "ltr"}
                disabled={readOnly}
                onClick={() => changeDirection("ltr")}
              >
                <AlignLeft aria-hidden="true" />
                <span><strong>Left to right</strong><small>English and most languages</small></span>
                {direction === "ltr" ? <Check className="ws-document-option-check" aria-hidden="true" /> : null}
              </button>
              <button
                type="button"
                className="ws-document-option"
                data-active={direction === "rtl"}
                aria-pressed={direction === "rtl"}
                disabled={readOnly}
                onClick={() => changeDirection("rtl")}
              >
                <AlignRight aria-hidden="true" />
                <span><strong>Right to left</strong><small>Hebrew, Arabic and similar</small></span>
                {direction === "rtl" ? <Check className="ws-document-option-check" aria-hidden="true" /> : null}
              </button>
              {!readOnly && (
                <>
                  <div className="ws-document-options-divider" />
                  <button type="button" className="ws-document-option ws-document-option-danger" onClick={() => {
                    setOptionsOpen(false);
                    if (confirm("Delete this document for everyone?")) void deleteDocument(id).then(onBack);
                  }}>
                    <Trash2 aria-hidden="true" /><span><strong>Delete document</strong><small>Remove for everyone</small></span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
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
        direction={direction}
        onDirectionChange={changeDirection}
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
    <div className="shell ws-signin-shell" data-maximized={maximized}>
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
