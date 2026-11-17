import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@hook/ui";

import type {
  Board,
  ChangesPage,
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
const demo = {
  projects: [DEMO_PROJECT],
  boards: [] as Board[],
  tasks: [] as Task[],
  comments: [] as Comment[],
  documents: [] as DocumentMeta[],
  folders: [] as Folder[],
  members: [] as Member[],
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
  if (path === "/projects" && method === "GET") return { projects: demo.projects };
  if (path === "/invites" && method === "GET") return { invites: demo.invites };
  if (path.startsWith("/changes")) {
    return { cursor: 1, hasMore: false, changes: [] } satisfies ChangesPage;
  }
  const project = /^\/projects\/([^/]+)/.exec(path);
  if (project) {
    const projectId = project[1];
    if (path.endsWith("/boards")) return { boards: demo.boards.filter((b) => b.projectId === projectId) };
    if (path.endsWith("/tasks")) return { tasks: demo.tasks };
    if (path.endsWith("/documents")) return { documents: demo.documents };
    if (path.endsWith("/members")) return { members: demo.members };
    if (path.endsWith("/folders")) return { folders: demo.folders };
  }
  if (path === "/projects" && method === "POST") {
    const name = String((body as { name?: string } | undefined)?.name ?? "Untitled");
    const created: Project = {
      ...DEMO_PROJECT,
      id: `wp_${demo.projects.length + 1}`,
      name,
      seq: demo.projects.length + 1,
    };
    demo.projects = [created, ...demo.projects];
    return { project: created };
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
  deleteFolder: (id: string) => call<{ ok: true }>("DELETE", `/folders/${id}`),

  boards: (projectId: string) =>
    call<{ boards: Board[] }>("GET", `/projects/${projectId}/boards`),
  board: (id: string) => call<{ board: Board }>("GET", `/boards/${id}`),
  createBoard: (projectId: string, name: string) =>
    call<{ board: Board }>("POST", `/projects/${projectId}/boards`, { name }),
  updateBoard: (id: string, patch: Partial<Pick<Board, "name" | "description">>) =>
    call<{ board: Board }>("PATCH", `/boards/${id}`, patch),
  deleteBoard: (id: string) => call<{ ok: true }>("DELETE", `/boards/${id}`),

  tasks: (boardId: string) =>
    call<{ tasks: Task[] }>("GET", `/boards/${boardId}/tasks`),
  task: (id: string) =>
    call<{ task: Task; comments: Comment[] }>("GET", `/tasks/${id}`),
  createTask: (
    boardId: string,
    task: { title: string; description?: string; status?: string; assignee?: string | null },
  ) => call<{ task: Task }>("POST", `/boards/${boardId}/tasks`, task),
  updateTask: (id: string, patch: Partial<Task>) =>
    call<{ task: Task }>("PATCH", `/tasks/${id}`, patch),
  deleteTask: (id: string) => call<{ ok: true }>("DELETE", `/tasks/${id}`),

  comments: (taskId: string) =>
    call<{ comments: Comment[] }>("GET", `/tasks/${taskId}/comments`),
  addComment: (taskId: string, body: string) =>
    call<{ comment: Comment }>("POST", `/tasks/${taskId}/comments`, { body }),
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
    patch: { title?: string; markdown?: string; baseRev?: number },
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
    call<{ members: Member[] }>("GET", `/projects/${projectId}/members`),
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
