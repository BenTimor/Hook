import { create } from "zustand";

import { api } from "../lib/bridge";
import type {
  Board,
  Change,
  Column,
  Comment,
  DocumentMeta,
  Folder,
  Invite,
  Member,
  Project,
  Task,
  TextDirection,
} from "../lib/types";

/** How often a visible window asks for changes. A focused window feels live. */
const POLL_MS = 5_000;

type ById<T> = Record<string, T>;

interface WorkspaceState {
  ready: boolean;
  error: string | null;
  projects: Project[];
  invites: Invite[];

  activeProjectId: string | null;
  activeBoardId: string | null;
  activeTaskId: string | null;
  activeDocumentId: string | null;

  boards: ById<Board[]>;
  tasks: ById<Task[]>;
  comments: ById<Comment[]>;
  documents: ById<DocumentMeta[]>;
  members: ById<Member[]>;
  /** Invitations nobody answered yet: the address is the only handle on them. */
  pending: ById<Invite[]>;
  folders: ById<Folder[]>;

  cursor: number;
  syncing: boolean;

  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  dismissError: () => void;

  openProject: (id: string | null) => Promise<void>;
  /** Boards, documents, folders and people of a project, without opening it. */
  loadProjectContents: (projectId: string) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  openBoard: (id: string | null, projectId?: string) => Promise<void>;
  createBoard: (
    projectId: string,
    name: string,
    folderId?: string | null,
    options?: { description?: string; columns?: Column[]; view?: "table" | "board" },
  ) => Promise<Board | null>;
  renameBoard: (id: string, name: string) => Promise<void>;
  updateBoardColumns: (id: string, columns: Column[]) => Promise<Board | null>;
  moveBoard: (id: string, folderId: string | null) => Promise<void>;
  deleteBoard: (id: string) => Promise<void>;

  openTask: (id: string | null) => Promise<void>;
  createTask: (
    boardId: string,
    status: string,
    options?: {
      title?: string;
      activate?: boolean;
      position?: number;
      fields?: Record<string, unknown>;
    },
  ) => Promise<Task | null>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<boolean>;
  /** Rows are ordered by hand: position becomes the index in this list. */
  reorderTasks: (boardId: string, orderedIds: string[]) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addComment: (taskId: string, body: string) => Promise<void>;
  editComment: (taskId: string, id: string, body: string) => Promise<boolean>;
  deleteComment: (taskId: string, id: string) => Promise<void>;

  openDocument: (id: string | null, projectId?: string) => Promise<void>;
  loadDocument: (id: string) => Promise<DocumentMeta | null>;
  createDocument: (
    projectId: string,
    title: string,
    folderId?: string | null,
  ) => Promise<DocumentMeta | null>;
  moveDocument: (id: string, folderId: string | null) => Promise<void>;
  renameDocument: (id: string, title: string) => Promise<void>;
  saveDocument: (
    id: string,
    patch: {
      title?: string;
      markdown?: string;
      baseRev?: number;
      folderId?: string | null;
      direction?: TextDirection;
    },
  ) => Promise<{ document: DocumentMeta | null; conflict: DocumentMeta | null }>;
  deleteDocument: (id: string) => Promise<void>;

  createFolder: (
    projectId: string,
    name: string,
    parentId?: string | null,
  ) => Promise<Folder | null>;
  renameFolder: (projectId: string, id: string, name: string) => Promise<void>;
  /** A folder can sit inside another one; `null` puts it at the top. */
  moveFolder: (projectId: string, id: string, parentId: string | null) => Promise<void>;
  deleteFolder: (projectId: string, id: string) => Promise<void>;

  refreshMembers: (projectId: string) => Promise<void>;
  invite: (projectId: string, email: string, role: string) => Promise<void>;
  setRole: (projectId: string, subject: string, role: string) => Promise<void>;
  removeMember: (projectId: string, subject: string) => Promise<void>;
  transferOwnership: (projectId: string, subject: string) => Promise<void>;

  acceptInvite: (id: string) => Promise<void>;
  declineInvite: (id: string) => Promise<void>;
}

const sortByPosition = <T extends { position: number; seq: number }>(items: T[]) =>
  [...items].sort((left, right) => left.position - right.position || left.seq - right.seq);

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((candidate) => candidate.id === item.id)
    ? items.map((candidate) => (candidate.id === item.id ? item : candidate))
    : [...items, item];
}

let poller: number | null = null;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ready: false,
  error: null,
  projects: [],
  invites: [],
  activeProjectId: null,
  activeBoardId: null,
  activeTaskId: null,
  activeDocumentId: null,
  boards: {},
  tasks: {},
  comments: {},
  documents: {},
  members: {},
  pending: {},
  folders: {},
  cursor: 0,
  syncing: false,

  async bootstrap() {
    try {
      const [projects, invites] = await Promise.all([api.projects(), api.invites()]);
      set({
        projects: projects.projects,
        invites: invites.invites,
        ready: true,
      });
      startPolling();
      await get().refresh();
    } catch (error) {
      set({ ready: true, error: message(error) });
    }
  },

  async refresh() {
    const { syncing } = get();
    if (syncing) return;
    set({ syncing: true });
    try {
      let cursor = get().cursor;
      for (let page = 0; page < 20; page += 1) {
        const result = await api.changes(cursor);
        for (const change of result.changes) applyChange(set, get, change);
        if (result.cursor === cursor && result.changes.length === 0) break;
        cursor = result.cursor;
        set({ cursor });
        if (!result.hasMore) break;
      }
      // Invitations are addressed to an email, not a project, so they are not
      // part of the cursor stream in the same way: a cheap refetch keeps the
      // inbox honest without a second cursor.
      const invites = await api.invites();
      set({ invites: invites.invites, error: null });
    } catch (error) {
      set({ error: message(error) });
    } finally {
      set({ syncing: false });
    }
  },

  dismissError() {
    set({ error: null });
  },

  async openProject(id) {
    set({ activeProjectId: id, activeBoardId: null, activeTaskId: null, activeDocumentId: null });
    if (!id) return;
    await get().loadProjectContents(id);
  },

  async loadProjectContents(projectId) {
    try {
      const [boards, documents, members, folders] = await Promise.all([
        api.boards(projectId),
        api.documents(projectId),
        api.members(projectId),
        api.folders(projectId),
      ]);
      set((state) => {
        const previous = state.documents[projectId] ?? [];
        return {
          boards: { ...state.boards, [projectId]: sortByPosition(boards.boards) },
          documents: {
            ...state.documents,
            [projectId]: documents.documents.map((document) => ({
              ...document,
              direction:
                directionOf(document.direction) ??
                previous.find((item) => item.id === document.id)?.direction ??
                cachedDirection(document.id) ??
                "ltr",
            })),
          },
          members: { ...state.members, [projectId]: members.members },
          // An older service has no pending list; a project without one simply
          // offers no addresses to assign to.
          pending: { ...state.pending, [projectId]: members.pending ?? [] },
          folders: { ...state.folders, [projectId]: sortByPosition(folders.folders) },
        };
      });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async createProject(name) {
    try {
      const created = await api.createProject(name);
      set((state) => ({ projects: [created.project, ...state.projects] }));
      await get().openProject(created.project.id);
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async renameProject(id, name) {
    try {
      const updated = await api.updateProject(id, { name });
      set((state) => ({
        projects: state.projects.map((project) =>
          project.id === id ? { ...project, ...updated.project } : project,
        ),
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async deleteProject(id) {
    try {
      await api.deleteProject(id);
      set((state) => ({
        projects: state.projects.filter((project) => project.id !== id),
        activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async openBoard(id, projectId) {
    const owner =
      projectId ??
      Object.values(get().boards)
        .flat()
        .find((board) => board.id === id)?.projectId;
    set({
      activeBoardId: id,
      activeTaskId: null,
      activeDocumentId: null,
      ...(owner ? { activeProjectId: owner } : {}),
    });
    if (!id) return;
    try {
      const tasks = await api.tasks(id);
      set((state) => ({ tasks: { ...state.tasks, [id]: tasks.tasks } }));
    } catch (error) {
      set({ error: message(error) });
    }
    // Opening a board from the tree must not skip the people: an assignee with
    // no name to match against is a number in the table.
    if (owner && !get().members[owner]) await get().loadProjectContents(owner);
  },

  async createBoard(projectId, name, folderId = null, options = {}) {
    try {
      const created = await api.createBoard(projectId, name, folderId, options);
      set((state) => ({
        boards: {
          ...state.boards,
          [projectId]: sortByPosition([...(state.boards[projectId] ?? []), created.board]),
        },
      }));
      return created.board;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  async moveBoard(id, folderId) {
    try {
      const updated = await api.updateBoard(id, { folderId });
      set((state) => ({
        boards: {
          ...state.boards,
          [updated.board.projectId]: sortByPosition(
            upsert(state.boards[updated.board.projectId] ?? [], updated.board),
          ),
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async renameBoard(id, name) {
    try {
      const updated = await api.updateBoard(id, { name });
      set((state) => ({
        boards: {
          ...state.boards,
          [updated.board.projectId]: sortByPosition(
            upsert(state.boards[updated.board.projectId] ?? [], updated.board),
          ),
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async updateBoardColumns(id, columns) {
    try {
      const updated = await api.updateBoard(id, { columns });
      set((state) => ({
        boards: {
          ...state.boards,
          [updated.board.projectId]: sortByPosition(
            upsert(state.boards[updated.board.projectId] ?? [], updated.board),
          ),
        },
      }));
      return updated.board;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  async deleteBoard(id) {
    try {
      await api.deleteBoard(id);
      const tasks = get().tasks[id] ?? [];
      set((state) => ({
        tasks: Object.fromEntries(Object.entries(state.tasks).filter(([boardId]) => boardId !== id)),
        comments: Object.fromEntries(
          Object.entries(state.comments).filter(
            ([taskId]) => !tasks.some((task) => task.id === taskId),
          ),
        ),
        boards: Object.fromEntries(
          Object.entries(state.boards).map(([project, boards]) => [
            project,
            boards.filter((board) => board.id !== id),
          ]),
        ),
        activeBoardId: state.activeBoardId === id ? null : state.activeBoardId,
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async openTask(id) {
    set({ activeTaskId: id });
    if (!id) return;
    try {
      const detail = await api.task(id);
      set((state) => ({
        tasks: { ...state.tasks, [detail.task.boardId]: upsert(state.tasks[detail.task.boardId] ?? [], detail.task) },
        comments: { ...state.comments, [id]: detail.comments },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async createTask(boardId, status, options = {}) {
    try {
      const position =
        options.position ??
        (get().tasks[boardId] ?? []).reduce((next, task) => Math.max(next, task.position + 1), 0);
      const created = await api.createTask(boardId, {
        title: options.title?.trim() || "New task",
        status,
        position,
        ...(options.fields ? { fields: options.fields } : {}),
      });
      set((state) => ({
        tasks: {
          ...state.tasks,
          [boardId]: sortByPosition([...(state.tasks[boardId] ?? []), created.task]),
        },
        // Quick add creates a row in place; the other entry points still open
        // the new task.
        activeTaskId: options.activate === false ? state.activeTaskId : created.task.id,
      }));
      return created.task;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  async updateTask(id, patch) {
    try {
      const updated = await api.updateTask(id, patch);
      set((state) => ({
        tasks: {
          ...state.tasks,
          [updated.task.boardId]: upsert(
            state.tasks[updated.task.boardId] ?? [],
            updated.task,
          ),
        },
      }));
      return true;
    } catch (error) {
      set({ error: message(error) });
      return false;
    }
  },

  async reorderTasks(boardId, orderedIds) {
    const current = get().tasks[boardId] ?? [];
    const byId = new Map(current.map((task) => [task.id, task]));
    const next = orderedIds
      .map((id, position) => {
        const task = byId.get(id);
        return task ? { ...task, position } : null;
      })
      .filter((task): task is Task => task !== null);
    // Optimistic: the rows move under the pointer before the round-trip.
    set((state) => ({ tasks: { ...state.tasks, [boardId]: next } }));
    const moved = next.filter((task) => byId.get(task.id)?.position !== task.position);
    if (moved.length === 0) return;
    try {
      await Promise.all(moved.map((task) => api.updateTask(task.id, { position: task.position })));
      const fresh = await api.tasks(boardId);
      set((state) => ({
        tasks: { ...state.tasks, [boardId]: sortByPosition(fresh.tasks) },
      }));
    } catch (error) {
      set((state) => ({ error: message(error), tasks: { ...state.tasks, [boardId]: current } }));
    }
  },

  async deleteTask(id) {
    try {
      await api.deleteTask(id);
      const task = findTask(get(), id);
      if (task) {
        set((state) => ({
          tasks: {
            ...state.tasks,
            [task.boardId]: (state.tasks[task.boardId] ?? []).filter((item) => item.id !== id),
          },
          activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
        }));
      }
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async addComment(taskId, body) {
    try {
      const created = await api.addComment(taskId, body);
      set((state) => ({
        comments: {
          ...state.comments,
          [taskId]: [...(state.comments[taskId] ?? []), created.comment],
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async editComment(taskId, id, body) {
    try {
      const updated = await api.editComment(id, body);
      set((state) => ({
        comments: {
          ...state.comments,
          [taskId]: upsert(state.comments[taskId] ?? [], updated.comment),
        },
      }));
      return true;
    } catch (error) {
      set({ error: message(error) });
      return false;
    }
  },

  async deleteComment(taskId, id) {
    try {
      await api.deleteComment(id);
      set((state) => ({
        comments: {
          ...state.comments,
          [taskId]: (state.comments[taskId] ?? []).filter((comment) => comment.id !== id),
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async openDocument(id, projectId) {
    set({
      activeDocumentId: id,
      activeBoardId: null,
      activeTaskId: null,
      ...(projectId ? { activeProjectId: projectId } : {}),
    });
    if (!id) return;
    const document = await get().loadDocument(id);
    const owner = projectId ?? document?.projectId;
    if (owner && document && !get().members[owner]) await get().loadProjectContents(owner);
  },

  async loadDocument(id) {
    try {
      const result = await api.document(id);
      const projectId = result.document.projectId;
      const existing = findDocument(get(), id);
      const direction =
        directionOf(result.document.direction) ??
        existing?.direction ??
        cachedDirection(id) ??
        "ltr";
      rememberDirection(id, direction);
      const document = { ...result.document, direction };
      set((state) => ({
        documents: {
          ...state.documents,
          [projectId]: upsert(state.documents[projectId] ?? [], document),
        },
      }));
      return document;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  async createDocument(projectId, title, folderId = null) {
    try {
      const created = await api.createDocument(projectId, { title, folderId });
      const document = {
        ...created.document,
        direction: directionOf(created.document.direction) ?? "ltr",
      };
      set((state) => ({
        documents: {
          ...state.documents,
          [projectId]: [document, ...(state.documents[projectId] ?? [])],
        },
        activeDocumentId: document.id,
      }));
      return document;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  async moveDocument(id, folderId) {
    const document = findDocument(get(), id);
    if (!document) return;
    // Only the folder moves; the editor's buffer and revision are untouched.
    const result = await get().saveDocument(id, { folderId });
    if (!result.document) return;
  },

  async renameDocument(id, title) {
    try {
      // The title is part of the document, so a rename is an ordinary save
      // without touching the Markdown or claiming a revision.
      const result = await api.saveDocument(id, { title });
      if (!result.document) return;
      const projectId = result.document.projectId;
      const existing = findDocument(get(), id);
      const direction =
        directionOf(result.document.direction) ??
        existing?.direction ??
        cachedDirection(id) ??
        "ltr";
      rememberDirection(id, direction);
      set((state) => ({
        documents: {
          ...state.documents,
          [projectId]: upsert(state.documents[projectId] ?? [], {
            ...result.document!,
            direction,
            markdown: undefined,
          }),
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async saveDocument(id, patch) {
    try {
      const result = await api.saveDocument(id, patch);
      if (!result.document) return result;
      const projectId = result.document.projectId;
      const existing = findDocument(get(), id);
      const direction =
        directionOf(result.document.direction) ??
        directionOf(patch.direction) ??
        existing?.direction ??
        cachedDirection(id) ??
        "ltr";
      rememberDirection(id, direction);
      const document = { ...result.document, direction };
      set((state) => ({
        documents: {
          ...state.documents,
          [projectId]: upsert(state.documents[projectId] ?? [], {
            ...document,
            markdown: undefined,
            bytes: result.document!.markdown?.length ?? 0,
          }),
        },
      }));
      return { ...result, document };
    } catch (error) {
      set({ error: message(error) });
      return { document: null, conflict: null };
    }
  },

  async createFolder(projectId, name, parentId = null) {
    try {
      const created = await api.createFolder(projectId, name, parentId);
      set((state) => ({
        folders: {
          ...state.folders,
          [projectId]: sortByPosition([...(state.folders[projectId] ?? []), created.folder]),
        },
      }));
      return created.folder;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  async renameFolder(projectId, id, name) {
    try {
      const updated = await api.updateFolder(id, { name });
      set((state) => ({
        folders: {
          ...state.folders,
          [projectId]: sortByPosition(upsert(state.folders[projectId] ?? [], updated.folder)),
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async moveFolder(projectId, id, parentId) {
    // A folder cannot live inside itself, nor inside anything below it.
    const folders = get().folders[projectId] ?? [];
    const descendants = new Set<string>();
    const walk = (parent: string) => {
      for (const folder of folders) {
        if (folder.parentId !== parent || descendants.has(folder.id)) continue;
        descendants.add(folder.id);
        walk(folder.id);
      }
    };
    walk(id);
    if (parentId === id || (parentId !== null && descendants.has(parentId))) return;
    try {
      const updated = await api.updateFolder(id, { parentId });
      set((state) => ({
        folders: {
          ...state.folders,
          [projectId]: sortByPosition(upsert(state.folders[projectId] ?? [], updated.folder)),
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async deleteFolder(projectId, id) {
    try {
      const before = new Set((get().boards[projectId] ?? []).map((board) => board.id));
      await api.deleteFolder(id);
      // A folder is a container: the server deletes what it held, so the
      // window reloads the project rather than guessing the cascade.
      await get().loadProjectContents(projectId);
      const state = get();
      const boards = state.boards[projectId] ?? [];
      const documents = state.documents[projectId] ?? [];
      const gone = new Set([...before].filter((boardId) => !boards.some((board) => board.id === boardId)));
      const boardGone = state.activeBoardId !== null && gone.has(state.activeBoardId);
      const documentGone =
        state.activeDocumentId !== null &&
        !documents.some((document) => document.id === state.activeDocumentId);
      set((current) => ({
        tasks: Object.fromEntries(
          Object.entries(current.tasks).filter(([boardId]) => !gone.has(boardId)),
        ),
        activeBoardId: boardGone ? null : current.activeBoardId,
        activeTaskId: boardGone ? null : current.activeTaskId,
        activeDocumentId: documentGone ? null : current.activeDocumentId,
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async deleteDocument(id) {
    try {
      await api.deleteDocument(id);
      forgetDirection(id);
      set((state) => ({
        documents: Object.fromEntries(
          Object.entries(state.documents).map(([project, documents]) => [
            project,
            documents.filter((document) => document.id !== id),
          ]),
        ),
        activeDocumentId: state.activeDocumentId === id ? null : state.activeDocumentId,
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async refreshMembers(projectId) {
    try {
      const members = await api.members(projectId);
      set((state) => ({
        members: { ...state.members, [projectId]: members.members },
        pending: { ...state.pending, [projectId]: members.pending ?? [] },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async invite(projectId, email, role) {
    try {
      await api.invite(projectId, email, role);
      await get().refreshMembers(projectId);
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async setRole(projectId, subject, role) {
    try {
      await api.setRole(projectId, subject, role);
      await get().refreshMembers(projectId);
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async removeMember(projectId, subject) {
    try {
      await api.removeMember(projectId, subject);
      await get().refreshMembers(projectId);
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async transferOwnership(projectId, subject) {
    try {
      await api.transferOwnership(projectId, subject);
      await Promise.all([get().refreshMembers(projectId), get().refresh()]);
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async acceptInvite(id) {
    try {
      await api.acceptInvite(id);
      const projects = await api.projects();
      set({ projects: projects.projects, invites: (await api.invites()).invites, error: null });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async declineInvite(id) {
    try {
      await api.declineInvite(id);
      set((state) => ({ invites: state.invites.filter((invite) => invite.id !== id), error: null }));
    } catch (error) {
      set({ error: message(error) });
    }
  },
}));

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
}

function directionOf(value: unknown): TextDirection | null {
  return value === "ltr" || value === "rtl" ? value : null;
}

const DIRECTION_KEY = "hook.workspace.document-direction.";

function cachedDirection(id: string): TextDirection | null {
  try {
    return directionOf(window.localStorage.getItem(`${DIRECTION_KEY}${id}`));
  } catch {
    return null;
  }
}

function rememberDirection(id: string, direction: TextDirection): void {
  try {
    window.localStorage.setItem(`${DIRECTION_KEY}${id}`, direction);
  } catch {
    // A document still works when storage is unavailable; the server is primary.
  }
}

function forgetDirection(id: string): void {
  try {
    window.localStorage.removeItem(`${DIRECTION_KEY}${id}`);
  } catch {
    // Nothing to clean up when storage is unavailable.
  }
}

function findDocument(state: WorkspaceState, id: string): DocumentMeta | null {
  for (const documents of Object.values(state.documents)) {
    const document = documents.find((candidate) => candidate.id === id);
    if (document) return document;
  }
  return null;
}

function findTask(state: WorkspaceState, id: string): Task | null {
  for (const tasks of Object.values(state.tasks)) {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task) return task;
  }
  return null;
}

/** Apply one feed row. The feed carries full rows, so this is an upsert/remove. */
function applyChange(
  set: (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void,
  get: () => WorkspaceState,
  change: Change,
) {
  const state = get();
  switch (change.kind) {
    case "project": {
      const project = change as unknown as Project;
      // `role` and `mine` are about the reader, not the project, so a feed row
      // from an older server may not carry them. Keep what the sign-in loaded.
      const existing = state.projects.find((candidate) => candidate.id === change.id);
      const merged = {
        ...(existing ?? project),
        ...project,
        seq: change.seq,
      };
      if (existing) {
        if (!project.role && existing.role) merged.role = existing.role;
        if (project.mine === undefined) merged.mine = existing.mine;
      }
      set({
        projects: change.deleted
          ? state.projects.filter((candidate) => candidate.id !== change.id)
          : upsert(state.projects, merged),
        activeProjectId:
          change.deleted && state.activeProjectId === change.id ? null : state.activeProjectId,
      });
      return;
    }
    case "board": {
      const projectId = change.projectId;
      if (!projectId) return;
      const board = change as unknown as Board;
      set({
        boards: {
          ...state.boards,
          [projectId]: change.deleted
            ? (state.boards[projectId] ?? []).filter((item) => item.id !== change.id)
            : sortByPosition(upsert(state.boards[projectId] ?? [], board)),
        },
      });
      return;
    }
    case "task": {
      const boardId = change.boardId as string | undefined;
      if (!boardId) return;
      const task = change as unknown as Task;
      set({
        tasks: {
          ...state.tasks,
          [boardId]: change.deleted
            ? (state.tasks[boardId] ?? []).filter((item) => item.id !== change.id)
            : sortByPosition(upsert(state.tasks[boardId] ?? [], task)),
        },
        activeTaskId:
          change.deleted && state.activeTaskId === change.id ? null : state.activeTaskId,
      });
      return;
    }
    case "comment": {
      const taskId = change.taskId as string | undefined;
      if (!taskId) return;
      set({
        comments: {
          ...state.comments,
          [taskId]: change.deleted
            ? (state.comments[taskId] ?? []).filter((item) => item.id !== change.id)
            : upsert(state.comments[taskId] ?? [], change as unknown as Comment),
        },
      });
      return;
    }
    case "document": {
      const projectId = change.projectId;
      if (!projectId) return;
      set({
        documents: {
          ...state.documents,
          [projectId]: change.deleted
            ? (state.documents[projectId] ?? []).filter((item) => item.id !== change.id)
            : upsert(state.documents[projectId] ?? [], {
                ...(change as unknown as DocumentMeta),
                // The open editor owns its buffer; a background update must not
                // overwrite what the user is typing.
                markdown: undefined,
              }),
        },
      });
      return;
    }
    case "folder": {
      const projectId = change.projectId;
      if (!projectId) return;
      set({
        folders: {
          ...state.folders,
          [projectId]: change.deleted
            ? (state.folders[projectId] ?? []).filter((item) => item.id !== change.id)
            : upsert(state.folders[projectId] ?? [], change as unknown as Folder),
        },
      });
      return;
    }
    case "member": {
      const projectId = change.projectId;
      if (!projectId) return;
      const subject = change.subject as string | undefined;
      if (!subject) return;
      // A feed row knows the role but not the profile, and an older server's
      // row carries neither name nor email. Until this project's people have
      // been listed, leave the map empty so opening a board loads them: a
      // nameless placeholder would otherwise win and the table would show
      // "Member" (or, before, the account number) forever.
      if (!state.members[projectId]) return;
      // Accepting an invitation turns the address into a member, so the same
      // address must stop being offered as a pending invitee.
      const email = (change.email as string | null)?.toLowerCase() ?? null;
      const pending = state.pending[projectId];
      set({
        members: {
          ...state.members,
          [projectId]: change.deleted
            ? (state.members[projectId] ?? []).filter((item) => item.subject !== subject)
            : upsertMember(state.members[projectId] ?? [], {
                subject,
                role: change.role as string,
                email: (change.email as string | null) ?? null,
                name: (change.name as string | null) ?? null,
                joinedAt: Number(change.joinedAt) || undefined,
              }),
        },
        ...(email && pending
          ? {
              pending: {
                ...state.pending,
                [projectId]: pending.filter(
                  (invite) => invite.email.toLowerCase() !== email,
                ),
              },
            }
          : {}),
      });
      return;
    }
    case "invite": {
      if (change.deleted) return;
      // Only invitations addressed to this account reach the feed.
      set({ invites: upsert(state.invites, change as unknown as Invite) });
      return;
    }
    default:
      return;
  }
}

/**
 * Apply a member row from the feed.
 *
 * The feed may know the role but not the profile; never let a missing name
 * erase one the window already has, or the table starts calling people by
 * their account number.
 */
function upsertMember(
  members: Member[],
  change: {
    subject: string;
    role: string;
    email: string | null;
    name: string | null;
    joinedAt?: number;
  },
): Member[] {
  const existing = members.find((member) => member.subject === change.subject);
  if (existing) {
    return members.map((member) =>
      member.subject === change.subject
        ? {
            ...member,
            role: change.role as Member["role"],
            email: change.email ?? member.email,
            name: change.name ?? member.name,
            joinedAt: change.joinedAt ?? member.joinedAt,
          }
        : member,
    );
  }
  return [
    ...members,
    {
      subject: change.subject,
      role: change.role as Member["role"],
      joinedAt: change.joinedAt ?? 0,
      email: change.email,
      name: change.name,
    },
  ];
}

function startPolling() {
  if (poller !== null) return;
  poller = window.setInterval(() => {
    if (document.visibilityState === "visible") void useWorkspaceStore.getState().refresh();
  }, POLL_MS);
  window.addEventListener("focus", () => void useWorkspaceStore.getState().refresh());
}
