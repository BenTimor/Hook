import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@hook/ui";

import type {
  Board,
  ChangesPage,
  Column,
  Comment,
  DocumentMeta,
  Folder,
  Invite,
  Member,
  Project,
  Task,
} from "./types";

/**
 * What the window needs to draw the login screen or the account row.
 * Mirrors `AuthView` in hook-core.
 */
export interface AuthView {
  signedIn: boolean;
  state: "signed_out" | "pending" | "signed_in";
  email?: string | null;
  name?: string | null;
  userCode?: string | null;
  verificationUrl?: string | null;
  message?: string | null;
}

export interface AppInfo {
  version: string;
  product?: "chat" | "workspace";
}

const DEMO_PROJECT: Project = {
  id: "wp_demo",
  name: "Website redesign",
  description: "The project you are looking at, for developing the UI.",
  owner: "local-preview",
  mine: true,
  role: "owner",
  createdAt: 0,
  updatedAt: 0,
  seq: 1,
};

/** A browser build (`pnpm workspace:dev`) has no backend; keep it browsable. */
let demoClock = 1_700_000_000_000;
let demoSeq = 10;
const demoId = (prefix: string) => `${prefix}_${(demoSeq += 1).toString(36)}`;
const demoNow = () => (demoClock += 1_000);

const DEMO_COLUMNS: Column[] = [
  {
    id: "col_status",
    name: "Status",
    type: "status",
    options: [
      { id: "opt_todo", label: "To do", color: "amber" },
      { id: "opt_doing", label: "In progress", color: "blue" },
      { id: "opt_done", label: "Done", color: "green" },
    ],
  },
  { id: "col_assignee", name: "Assignee", type: "person" },
];

/** In-memory stand-in for the workspace API, so the UI is clickable in a browser. */
const demo = {
  projects: [DEMO_PROJECT],
  boards: [
    {
      id: "bd_demo",
      projectId: DEMO_PROJECT.id,
      folderId: "fd_demo",
      name: "Sprint 1",
      description: "",
      columns: DEMO_COLUMNS,
      position: 0,
      updatedAt: demoNow(),
      seq: 4,
    },
  ] as Board[],
  tasks: [
    {
      id: "tk_demo1",
      projectId: DEMO_PROJECT.id,
      boardId: "bd_demo",
      title: "Pick a type stack",
      description: "Inter, a serif for quotes, and nothing else.",
      status: "opt_done",
      assignee: null,
      assignees: [],
      fields: {},
      position: 0,
      createdBy: "local-preview",
      createdAt: demoNow(),
      updatedAt: demoNow(),
      seq: 5,
    },
    {
      id: "tk_demo2",
      projectId: DEMO_PROJECT.id,
      boardId: "bd_demo",
      title: "Draw the empty states",
      description: "",
      status: "opt_doing",
      assignee: null,
      assignees: [],
      fields: {},
      position: 0,
      createdBy: "local-preview",
      createdAt: demoNow(),
      updatedAt: demoNow(),
      seq: 6,
    },
  ] as Task[],
  comments: [] as Comment[],
  documents: [
    {
      id: "dc_demo",
      projectId: DEMO_PROJECT.id,
      folderId: null,
      title: "Brand brief",
      markdown: "# Brand brief\n\nQuiet, warm, a little literary.\n",
      bytes: 44,
      rev: 1,
      updatedBy: "local-preview",
      createdAt: demoNow(),
      updatedAt: demoNow(),
      seq: 7,
    },
  ] as DocumentMeta[],
  folders: [
    {
      id: "fd_demo",
      projectId: DEMO_PROJECT.id,
      parentId: null,
      name: "Design",
      position: 0,
      updatedAt: demoNow(),
      seq: 3,
    },
  ] as Folder[],
  members: [
    {
      subject: "local-preview",
      role: "owner",
      joinedAt: demoNow(),
      email: "you@example.com",
      name: "You",
    },
  ] as Member[],
  invites: [] as Invite[],
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/**
 * The window's whole backend. One command reaches the workspace API; the Rust
 * side attaches the account token, so no credential is ever in this process.
 * The status code survives because a 409 is a conversation, not a failure.
 */
async function call<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const result = isTauri()
    ? await invoke<{ status: number; body: unknown }>("ws_request", { method, path, body })
    : { status: 200, body: demoRequest(path, method, body) };
  if (result.status >= 400) {
    const message =
      (result.body as { error?: { message?: string } })?.error?.message ??
      "The workspace service refused that request.";
    throw new ApiError(result.status, message, result.body);
  }
  return result.body as T;
}

/** Enough of an API to click around without the desktop shell. */
function demoRequest(path: string, method: string, body?: unknown): unknown {
  const [root, id, resource] = path.split("?")[0].split("/").filter(Boolean);
  const payload = (body ?? {}) as Record<string, unknown>;

  if (path.startsWith("/changes")) {
    return { cursor: 1, hasMore: false, changes: [] } satisfies ChangesPage;
  }

  if (root === "projects") {
    if (!id) {
      if (method === "GET") return { projects: demo.projects };
      const project: Project = {
        ...DEMO_PROJECT,
        id: demoId("wp"),
        name: String(payload.name ?? "Untitled"),
        description: String(payload.description ?? ""),
        createdAt: demoNow(),
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.projects = [project, ...demo.projects];
      return { project };
    }

    if (method === "GET") {
      switch (resource) {
        case "boards":
          return { boards: demo.boards.filter((board) => board.projectId === id) };
        case "documents":
          return {
            documents: demo.documents.filter((document) => document.projectId === id),
          };
        case "folders":
          return { folders: demo.folders.filter((folder) => folder.projectId === id) };
        case "members":
          return {
            members: demo.members,
            pending: demo.invites.filter((invite) => invite.projectId === id),
          };
        case "invites":
          return { invites: demo.invites };
        default:
          return {};
      }
    }

    if (resource === "folders") {
      const folder: Folder = {
        id: demoId("fd"),
        projectId: id,
        parentId: (payload.parentId as string | null) ?? null,
        name: String(payload.name ?? "Folder"),
        position: demoSeq,
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.folders = [...demo.folders, folder];
      return { folder };
    }
    if (resource === "boards") {
      const board: Board = {
        id: demoId("bd"),
        projectId: id,
        folderId: (payload.folderId as string | null) ?? null,
        name: String(payload.name ?? "Board"),
        description: "",
        columns: DEMO_COLUMNS,
        position: demoSeq,
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.boards = [...demo.boards, board];
      return { board };
    }
    if (resource === "documents") {
      const document: DocumentMeta = {
        id: demoId("dc"),
        projectId: id,
        folderId: (payload.folderId as string | null) ?? null,
        title: String(payload.title ?? "Untitled"),
        markdown: String(payload.markdown ?? ""),
        bytes: String(payload.markdown ?? "").length,
        rev: 1,
        updatedBy: "local-preview",
        createdAt: demoNow(),
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.documents = [document, ...demo.documents];
      return { document };
    }
    return { ok: true };
  }

  if (root === "folders") {
    if (method === "PATCH") {
      demo.folders = demo.folders.map((folder) =>
        folder.id === id ? { ...folder, ...payload, updatedAt: demoNow() } : folder,
      );
      return { folder: demo.folders.find((folder) => folder.id === id) };
    }
    if (method === "DELETE") {
      // A folder is a container: its subfolders, boards (with tasks) and
      // documents go with it, exactly like the server's cascade.
      const inside = new Set([String(id)]);
      for (const folder of inside) {
        for (const candidate of demo.folders) {
          if (candidate.parentId === folder) inside.add(candidate.id);
        }
      }
      const boards = new Set(
        demo.boards.filter((board) => board.folderId && inside.has(board.folderId)).map((board) => board.id),
      );
      demo.tasks = demo.tasks.filter((task) => !boards.has(task.boardId));
      demo.boards = demo.boards.filter((board) => !boards.has(board.id));
      demo.documents = demo.documents.filter(
        (document) => !(document.folderId && inside.has(document.folderId)),
      );
      demo.folders = demo.folders.filter((folder) => !inside.has(folder.id));
      return { ok: true };
    }
  }

  if (root === "boards") {
    if (method === "PATCH") {
      demo.boards = demo.boards.map((board) =>
        board.id === id ? { ...board, ...payload, updatedAt: demoNow() } : board,
      );
      return { board: demo.boards.find((board) => board.id === id) };
    }
    if (method === "DELETE") {
      demo.boards = demo.boards.filter((board) => board.id !== id);
      demo.tasks = demo.tasks.filter((task) => task.boardId !== id);
      demo.comments = demo.comments.filter((comment) => comment.taskId !== undefined);
      return { ok: true };
    }
    if (resource === "tasks") {
      if (method === "GET") {
        return {
          tasks: demo.tasks
            .filter((task) => task.boardId === id)
            .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt),
        };
      }
      const board = demo.boards.find((candidate) => candidate.id === id);
      const assignees = Array.isArray(payload.assignees)
        ? payload.assignees.map(String)
        : typeof payload.assignee === "string"
          ? [payload.assignee]
          : [];
      const task: Task = {
        id: demoId("tk"),
        projectId: board?.projectId ?? DEMO_PROJECT.id,
        boardId: String(id),
        title: String(payload.title ?? "New task"),
        description: String(payload.description ?? ""),
        status: String(payload.status ?? "opt_todo"),
        assignee: assignees[0] ?? null,
        assignees,
        fields: {},
        position: demo.tasks.filter((task) => task.boardId === id).length,
        createdBy: "local-preview",
        createdAt: demoNow(),
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.tasks = [...demo.tasks, task];
      return { task };
    }
    if (method === "GET") {
      return { board: demo.boards.find((board) => board.id === id) };
    }
  }

  if (root === "tasks") {
    const task = demo.tasks.find((candidate) => candidate.id === id);
    if (method === "PATCH") {
      demo.tasks = demo.tasks.map((candidate) => {
        if (candidate.id !== id) return candidate;
        const next: Task = { ...candidate, ...payload, updatedAt: demoNow() };
        if (Array.isArray(payload.assignees)) {
          next.assignees = payload.assignees.map(String);
          next.assignee = next.assignees[0] ?? null;
        } else if (payload.assignee !== undefined) {
          next.assignees = typeof payload.assignee === "string" ? [payload.assignee] : [];
          next.assignee = next.assignees[0] ?? null;
        }
        return next;
      });
      return { task: demo.tasks.find((candidate) => candidate.id === id) };
    }
    if (method === "DELETE") {
      demo.tasks = demo.tasks.filter((candidate) => candidate.id !== id);
      return { ok: true };
    }
    if (resource === "comments") {
      if (method === "GET") {
        return { comments: demo.comments.filter((comment) => comment.taskId === id) };
      }
      const comment: Comment = {
        id: demoId("cm"),
        projectId: task?.projectId ?? DEMO_PROJECT.id,
        taskId: String(id),
        author: "local-preview",
        authorKind: "user",
        viaChatId: null,
        body: String(payload.body ?? ""),
        createdAt: demoNow(),
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.comments = [...demo.comments, comment];
      return { comment };
    }
    return { task, comments: demo.comments.filter((comment) => comment.taskId === id) };
  }

  if (root === "comments") {
    if (method === "PATCH") {
      demo.comments = demo.comments.map((comment) =>
        comment.id === id
          ? { ...comment, body: String(payload.body ?? comment.body), updatedAt: demoNow() }
          : comment,
      );
      return { comment: demo.comments.find((comment) => comment.id === id) };
    }
    if (method === "DELETE") {
      demo.comments = demo.comments.filter((comment) => comment.id !== id);
      return { ok: true };
    }
  }

  if (root === "documents") {
    if (method === "PATCH") {
      demo.documents = demo.documents.map((document) =>
        document.id === id
          ? {
              ...document,
              ...payload,
              markdown:
                payload.markdown === undefined
                  ? document.markdown
                  : String(payload.markdown),
              rev: document.rev + 1,
              updatedAt: demoNow(),
            }
          : document,
      );
      return { document: demo.documents.find((document) => document.id === id) };
    }
    if (method === "DELETE") {
      demo.documents = demo.documents.filter((document) => document.id !== id);
      return { ok: true };
    }
    return { document: demo.documents.find((document) => document.id === id) };
  }

  if (root === "comments" && method === "DELETE") {
    demo.comments = demo.comments.filter((comment) => comment.id !== id);
    return { ok: true };
  }

  if (root === "invites") {
    if (method === "GET") return { invites: demo.invites };
    return { ok: true };
  }

  return {};
}

export const api = {
  appInfo: (): Promise<AppInfo> =>
    isTauri()
      ? invoke<AppInfo>("app_info")
      : Promise.resolve({ version: "0.1.0", product: "workspace" }),

  authStatus: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_status")
      : Promise.resolve({
          signedIn: true,
          state: "signed_in",
          email: "you@example.com",
          name: "You",
        }),

  authLogin: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_login")
      : Promise.resolve({ signedIn: true, state: "signed_in", email: "you@example.com" }),

  authCancelLogin: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_cancel_login")
      : Promise.resolve({ signedIn: false, state: "signed_out" }),

  authLogout: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_logout")
      : Promise.resolve({ signedIn: false, state: "signed_out" }),

  // ── Workspace ────────────────────────────────────────────────────────────
  projects: () => call<{ projects: Project[] }>("GET", "/projects"),
  createProject: (name: string, description = "") =>
    call<{ project: Project }>("POST", "/projects", { name, description }),
  updateProject: (id: string, patch: { name?: string; description?: string }) =>
    call<{ project: Project }>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/projects/${id}`),

  folders: (projectId: string) =>
    call<{ folders: Folder[] }>("GET", `/projects/${projectId}/folders`),
  createFolder: (projectId: string, name: string, parentId: string | null = null) =>
    call<{ folder: Folder }>("POST", `/projects/${projectId}/folders`, { name, parentId }),
  updateFolder: (
    id: string,
    patch: { name?: string; parentId?: string | null; position?: number },
  ) => call<{ folder: Folder }>("PATCH", `/folders/${id}`, patch),
  deleteFolder: (id: string) => call<{ ok: true }>("DELETE", `/folders/${id}`),

  boards: (projectId: string) =>
    call<{ boards: Board[] }>("GET", `/projects/${projectId}/boards`),
  board: (id: string) => call<{ board: Board }>("GET", `/boards/${id}`),
  createBoard: (projectId: string, name: string, folderId: string | null = null) =>
    call<{ board: Board }>("POST", `/projects/${projectId}/boards`, { name, folderId }),
  updateBoard: (
    id: string,
    patch: Partial<Pick<Board, "name" | "description" | "folderId" | "columns">>,
  ) => call<{ board: Board }>("PATCH", `/boards/${id}`, patch),
  deleteBoard: (id: string) => call<{ ok: true }>("DELETE", `/boards/${id}`),

  tasks: (boardId: string) =>
    call<{ tasks: Task[] }>("GET", `/boards/${boardId}/tasks`),
  task: (id: string) =>
    call<{ task: Task; comments: Comment[] }>("GET", `/tasks/${id}`),
  createTask: (
    boardId: string,
    task: {
      title: string;
      description?: string;
      status?: string;
      assignee?: string | null;
      assignees?: string[];
    },
  ) => call<{ task: Task }>("POST", `/boards/${boardId}/tasks`, task),
  updateTask: (id: string, patch: Partial<Task>) =>
    call<{ task: Task }>("PATCH", `/tasks/${id}`, patch),
  deleteTask: (id: string) => call<{ ok: true }>("DELETE", `/tasks/${id}`),

  comments: (taskId: string) =>
    call<{ comments: Comment[] }>("GET", `/tasks/${taskId}/comments`),
  addComment: (taskId: string, body: string) =>
    call<{ comment: Comment }>("POST", `/tasks/${taskId}/comments`, { body }),
  editComment: (id: string, body: string) =>
    call<{ comment: Comment }>("PATCH", `/comments/${id}`, { body }),
  deleteComment: (id: string) => call<{ ok: true }>("DELETE", `/comments/${id}`),

  documents: (projectId: string) =>
    call<{ documents: DocumentMeta[] }>("GET", `/projects/${projectId}/documents`),
  document: (id: string) =>
    call<{ document: DocumentMeta }>("GET", `/documents/${id}`),
  createDocument: (
    projectId: string,
    document: { title: string; markdown?: string; folderId?: string | null },
  ) => call<{ document: DocumentMeta }>("POST", `/projects/${projectId}/documents`, document),
  /** `baseRev` makes a stale write a conflict instead of an overwrite. */
  /**
   * `baseRev` makes a stale write a conflict instead of an overwrite. The
   * current copy comes back with it, so the editor can offer a choice.
   */
  async saveDocument(
    id: string,
    patch: { title?: string; markdown?: string; baseRev?: number; folderId?: string | null },
  ): Promise<{ document: DocumentMeta | null; conflict: DocumentMeta | null }> {
    try {
      const result = await call<{ document: DocumentMeta }>("PATCH", `/documents/${id}`, patch);
      return { document: result.document, conflict: null };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const current = (error.body as { document?: DocumentMeta })?.document ?? null;
        return { document: null, conflict: current };
      }
      throw error;
    }
  },
  deleteDocument: (id: string) => call<{ ok: true }>("DELETE", `/documents/${id}`),

  members: (projectId: string) =>
    call<{ members: Member[]; pending: Invite[] }>("GET", `/projects/${projectId}/members`),
  invite: (projectId: string, email: string, role: string) =>
    call<{ invite: Invite }>("POST", `/projects/${projectId}/invites`, { email, role }),
  setRole: (projectId: string, subject: string, role: string) =>
    call<{ member: Member }>("PATCH", `/projects/${projectId}/members/${subject}`, { role }),
  removeMember: (projectId: string, subject: string) =>
    call<{ ok: true }>("DELETE", `/projects/${projectId}/members/${subject}`),
  transferOwnership: (projectId: string, subject: string) =>
    call<{ ok: true }>("POST", `/projects/${projectId}/owner`, { subject }),

  invites: () => call<{ invites: Invite[] }>("GET", "/invites"),
  acceptInvite: (id: string) => call<{ ok: true }>("POST", `/invites/${id}/accept`, {}),
  declineInvite: (id: string) => call<{ ok: true }>("POST", `/invites/${id}/decline`, {}),

  changes: (since: number, limit = 200) =>
    call<ChangesPage>("GET", `/changes?since=${since}&limit=${limit}`),
};

/** Account changes also arrive as events: sign-in completes in the background. */
export function onAuthEvent(callback: (view: AuthView) => void): () => void {
  if (!isTauri()) return () => {};
  const pending = listen<AuthView>("hook://auth", (event) => callback(event.payload));
  return () => {
    void pending.then((off) => off()).catch(() => {});
  };
}

/** Open an http(s) URL in the system browser. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_url", { url });
}
