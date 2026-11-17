import { create } from "zustand";

import { api } from "../lib/bridge";
import type {
  Board,
  Change,
  Comment,
  DocumentMeta,
  Folder,
  Invite,
  Member,
  Project,
  Task,
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
  folders: ById<Folder[]>;

  cursor: number;
  syncing: boolean;

  bootstrap: () => Promise<void>;
  refresh: () => Promise<void>;
  dismissError: () => void;

  openProject: (id: string | null) => Promise<void>;
  createProject: (name: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  openBoard: (id: string | null) => Promise<void>;
  createBoard: (projectId: string, name: string, folderId?: string | null) => Promise<Board | null>;
  moveBoard: (id: string, folderId: string | null) => Promise<void>;
  deleteBoard: (id: string) => Promise<void>;

  openTask: (id: string | null) => Promise<void>;
  createTask: (boardId: string, status: string) => Promise<Task | null>;
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addComment: (taskId: string, body: string) => Promise<void>;
  deleteComment: (taskId: string, id: string) => Promise<void>;

  openDocument: (id: string | null) => Promise<void>;
  loadDocument: (id: string) => Promise<DocumentMeta | null>;
  createDocument: (
    projectId: string,
    title: string,
    folderId?: string | null,
  ) => Promise<DocumentMeta | null>;
  moveDocument: (id: string, folderId: string | null) => Promise<void>;
  saveDocument: (
    id: string,
    patch: { title?: string; markdown?: string; baseRev?: number; folderId?: string | null },
  ) => Promise<{ document: DocumentMeta | null; conflict: DocumentMeta | null }>;
  deleteDocument: (id: string) => Promise<void>;

  createFolder: (
    projectId: string,
    name: string,
    parentId?: string | null,
  ) => Promise<Folder | null>;
  renameFolder: (projectId: string, id: string, name: string) => Promise<void>;
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
    try {
      const [boards, documents, members, folders] = await Promise.all([
        api.boards(id),
        api.documents(id),
        api.members(id),
        api.folders(id),
      ]);
      set((state) => ({
        boards: { ...state.boards, [id]: boards.boards },
        documents: { ...state.documents, [id]: documents.documents },
        members: { ...state.members, [id]: members.members },
        folders: { ...state.folders, [id]: folders.folders },
      }));
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

  async openBoard(id) {
    set({ activeBoardId: id, activeTaskId: null });
    if (!id) return;
    try {
      const tasks = await api.tasks(id);
      set((state) => ({ tasks: { ...state.tasks, [id]: tasks.tasks } }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async createBoard(projectId, name, folderId = null) {
    try {
      const created = await api.createBoard(projectId, name, folderId);
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

  async deleteBoard(id) {
    try {
      await api.deleteBoard(id);
      set((state) => ({
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

  async createTask(boardId, status) {
    try {
      const created = await api.createTask(boardId, { title: "New task", status });
      set((state) => ({
        tasks: {
          ...state.tasks,
          [boardId]: sortByPosition([...(state.tasks[boardId] ?? []), created.task]),
        },
        activeTaskId: created.task.id,
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
    } catch (error) {
      set({ error: message(error) });
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

  async openDocument(id) {
    set({ activeDocumentId: id });
    if (id) await get().loadDocument(id);
  },

  async loadDocument(id) {
    try {
      const result = await api.document(id);
      const projectId = result.document.projectId;
      set((state) => ({
        documents: {
          ...state.documents,
          [projectId]: upsert(state.documents[projectId] ?? [], result.document),
        },
      }));
      return result.document;
    } catch (error) {
      set({ error: message(error) });
      return null;
    }
  },

  async createDocument(projectId, title, folderId = null) {
    try {
      const created = await api.createDocument(projectId, { title, folderId });
      set((state) => ({
        documents: {
          ...state.documents,
          [projectId]: [created.document, ...(state.documents[projectId] ?? [])],
        },
        activeDocumentId: created.document.id,
      }));
      return created.document;
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

  async saveDocument(id, patch) {
    try {
      const result = await api.saveDocument(id, patch);
      if (result.document) {
        const projectId = result.document.projectId;
        set((state) => ({
          documents: {
            ...state.documents,
            [projectId]: upsert(state.documents[projectId] ?? [], {
              ...result.document!,
              markdown: undefined,
              bytes: result.document!.markdown?.length ?? 0,
            }),
          },
        }));
      }
      return result;
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

  async deleteFolder(projectId, id) {
    try {
      await api.deleteFolder(id);
      // The server leaves the contents alone, and a board or document whose
      // folder is gone belongs at the top level rather than nowhere.
      set((state) => ({
        folders: {
          ...state.folders,
          [projectId]: (state.folders[projectId] ?? []).filter((folder) => folder.id !== id),
        },
        boards: {
          ...state.boards,
          [projectId]: (state.boards[projectId] ?? []).map((board) =>
            board.folderId === id ? { ...board, folderId: null } : board,
          ),
        },
        documents: {
          ...state.documents,
          [projectId]: (state.documents[projectId] ?? []).map((document) =>
            document.folderId === id ? { ...document, folderId: null } : document,
          ),
        },
      }));
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async deleteDocument(id) {
    try {
      await api.deleteDocument(id);
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
      set((state) => ({ members: { ...state.members, [projectId]: members.members } }));
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
      set({ projects: projects.projects, invites: (await api.invites()).invites });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async declineInvite(id) {
    try {
      await api.declineInvite(id);
      set((state) => ({ invites: state.invites.filter((invite) => invite.id !== id) }));
    } catch (error) {
      set({ error: message(error) });
    }
  },
}));

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Something went wrong.";
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
      set({
        projects: change.deleted
          ? state.projects.filter((candidate) => candidate.id !== change.id)
          : upsert(state.projects, { ...project, seq: change.seq }),
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
      set({
        members: {
          ...state.members,
          [projectId]: change.deleted
            ? (state.members[projectId] ?? []).filter((item) => item.subject !== subject)
            : upsertMember(state.members[projectId] ?? [], subject, change.role as string),
        },
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

function upsertMember(members: Member[], subject: string, role: string): Member[] {
  return members.some((member) => member.subject === subject)
    ? members.map((member) =>
        member.subject === subject ? { ...member, role: role as Member["role"] } : member,
      )
    : [...members, { subject, role: role as Member["role"], joinedAt: 0, email: null, name: null }];
}

function startPolling() {
  if (poller !== null) return;
  poller = window.setInterval(() => {
    if (document.visibilityState === "visible") void useWorkspaceStore.getState().refresh();
  }, POLL_MS);
  window.addEventListener("focus", () => void useWorkspaceStore.getState().refresh());
}
