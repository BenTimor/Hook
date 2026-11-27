import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@hook/ui";

import type {
  Board,
  Brainstorm,
  BrainstormIdea,
  ChangesPage,
  Column,
  Comment,
  DocumentMeta,
  Folder,
  Invite,
  Member,
  Milestone,
  Project,
  Roadmap,
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
  /** `free`, `plus` or `pro`. Null on the browser preview. */
  plan?: string | null;
  /** The account-wide cloud-sync switch. */
  cloudSync?: boolean | null;
  /** The free plan's rolling message window. Null on a paid plan. */
  quota?: {
    limit: number;
    used: number;
    remaining: number;
    resetAt: string | null;
  } | null;
}

/** A model endpoint the user brought themselves, for this product only. */
export interface CustomProvider {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface SettingsView {
  projectsDir: string;
  advancedMode: boolean;
  plan: string | null;
  cloudSync: boolean;
  customProvider: CustomProvider | null;
}

export interface SyncView {
  enabled: boolean;
  available: boolean;
  reason: "free" | "off" | null;
  state: "off" | "idle" | "syncing" | "error";
  cursor: number;
  pending: number;
  lastSyncAt: number;
  message: string | null;
}

/** The browser preview's account, for the Settings dialog. */
let demoCloudSync = true;
let demoProvider: CustomProvider | null = null;

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
  roadmaps: [
    {
      id: "rm_demo",
      projectId: DEMO_PROJECT.id,
      folderId: "fd_demo",
      name: "Release roadmap",
      description: "The path to the first public build.",
      position: 0,
      updatedAt: demoNow(),
      seq: 8,
    },
  ] as Roadmap[],
  milestones: [
    {
      id: "ms_demo",
      projectId: DEMO_PROJECT.id,
      roadmapId: "rm_demo",
      title: "First release",
      description: "Ship the first public build.",
      dueDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
      status: "active",
      position: 0,
      createdAt: demoNow(),
      updatedAt: demoNow(),
      seq: 9,
    },
  ] as Milestone[],
  brainstorms: [
    {
      id: "bs_demo",
      projectId: DEMO_PROJECT.id,
      folderId: null,
      name: "Name",
      description: "What should the product be called?",
      position: 0,
      updatedAt: demoNow(),
      seq: 10,
    },
  ] as Brainstorm[],
  brainstormIdeas: [
    {
      id: "bi_demo1",
      projectId: DEMO_PROJECT.id,
      brainstormId: "bs_demo",
      text: "Hook",
      position: 0,
      createdAt: demoNow(),
      updatedAt: demoNow(),
      seq: 11,
    },
    {
      id: "bi_demo2",
      projectId: DEMO_PROJECT.id,
      brainstormId: "bs_demo",
      text: "Heimdall",
      position: 1,
      createdAt: demoNow(),
      updatedAt: demoNow(),
      seq: 12,
    },
    {
      id: "bi_demo3",
      projectId: DEMO_PROJECT.id,
      brainstormId: "bs_demo",
      text: "Ladybugs",
      position: 2,
      createdAt: demoNow(),
      updatedAt: demoNow(),
      seq: 13,
    },
  ] as BrainstormIdea[],
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
        case "milestones":
          return {
            milestones: demo.milestones.filter((milestone) => milestone.projectId === id),
          };
        case "roadmaps":
          return {
            roadmaps: demo.roadmaps.filter((roadmap) => roadmap.projectId === id),
          };
        case "brainstorms":
          return {
            brainstorms: demo.brainstorms.filter((brainstorm) => brainstorm.projectId === id),
          };
        case "brainstorm-ideas":
          return {
            ideas: demo.brainstormIdeas
              .filter((idea) => idea.projectId === id)
              .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt),
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
        description: String(payload.description ?? ""),
        columns: Array.isArray(payload.columns) ? (payload.columns as Column[]) : DEMO_COLUMNS,
        view: payload.view === "board" ? "board" : "table",
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
    if (resource === "roadmaps") {
      const roadmap: Roadmap = {
        id: demoId("rm"),
        projectId: id,
        folderId: (payload.folderId as string | null) ?? null,
        name: String(payload.name ?? "Roadmap"),
        description: String(payload.description ?? ""),
        position: demoSeq,
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.roadmaps = [...demo.roadmaps, roadmap];
      return { roadmap };
    }
    if (resource === "brainstorms") {
      const brainstorm: Brainstorm = {
        id: demoId("bs"),
        projectId: id,
        folderId: (payload.folderId as string | null) ?? null,
        name: String(payload.name ?? "Brainstorm"),
        description: String(payload.description ?? ""),
        position: demoSeq,
        updatedAt: demoNow(),
        seq: demoSeq,
      };
      demo.brainstorms = [...demo.brainstorms, brainstorm];
      return { brainstorm };
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
      const brainstorms = new Set(
        demo.brainstorms
          .filter((brainstorm) => brainstorm.folderId && inside.has(brainstorm.folderId))
          .map((brainstorm) => brainstorm.id),
      );
      demo.brainstormIdeas = demo.brainstormIdeas.filter((idea) => !brainstorms.has(idea.brainstormId));
      demo.brainstorms = demo.brainstorms.filter((brainstorm) => !brainstorms.has(brainstorm.id));
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
        fields:
          payload.fields && typeof payload.fields === "object"
            ? (payload.fields as Record<string, unknown>)
            : {},
        position: Number.isSafeInteger(payload.position)
          ? Number(payload.position)
          : demo.tasks.filter((task) => task.boardId === id).length,
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

  if (root === "brainstorms") {
    const brainstorm = demo.brainstorms.find((candidate) => candidate.id === id);
    if (!brainstorm) return { ok: true };
    if (resource === "ideas") {
      if (method === "GET") {
        return {
          ideas: demo.brainstormIdeas
            .filter((idea) => idea.brainstormId === id)
            .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt),
        };
      }
      if (method === "POST") {
        const idea: BrainstormIdea = {
          id: demoId("bi"),
          projectId: brainstorm.projectId,
          brainstormId: brainstorm.id,
          text: String(payload.text ?? ""),
          position: demoSeq,
          createdAt: demoNow(),
          updatedAt: demoNow(),
          seq: demoSeq,
        };
        demo.brainstormIdeas = [...demo.brainstormIdeas, idea];
        return { idea };
      }
    }
    if (method === "PATCH") {
      demo.brainstorms = demo.brainstorms.map((candidate) =>
        candidate.id === id ? { ...candidate, ...payload, updatedAt: demoNow() } : candidate,
      );
      return { brainstorm: demo.brainstorms.find((candidate) => candidate.id === id) };
    }
    if (method === "DELETE") {
      demo.brainstorms = demo.brainstorms.filter((candidate) => candidate.id !== id);
      demo.brainstormIdeas = demo.brainstormIdeas.filter((idea) => idea.brainstormId !== id);
      return { ok: true };
    }
    return { brainstorm };
  }

  if (root === "ideas") {
    if (method === "PATCH") {
      demo.brainstormIdeas = demo.brainstormIdeas.map((idea) =>
        idea.id === id
          ? {
              ...idea,
              text: payload.text === undefined ? idea.text : String(payload.text),
              position:
                typeof payload.position === "number" ? payload.position : idea.position,
              updatedAt: demoNow(),
            }
          : idea,
      );
      return { idea: demo.brainstormIdeas.find((idea) => idea.id === id) };
    }
    if (method === "DELETE") {
      demo.brainstormIdeas = demo.brainstormIdeas.filter((idea) => idea.id !== id);
      return { ok: true };
    }
    return { ok: true };
  }

  if (root === "roadmaps") {
    const roadmap = demo.roadmaps.find((candidate) => candidate.id === id);
    if (!roadmap) return { ok: true };
    if (resource === "milestones") {
      if (method === "GET") {
        return { milestones: demo.milestones.filter((milestone) => milestone.roadmapId === id) };
      }
      if (method === "POST") {
        const milestone: Milestone = {
          id: demoId("ms"),
          projectId: roadmap.projectId,
          roadmapId: roadmap.id,
          title: String(payload.title ?? "Milestone"),
          description: String(payload.description ?? ""),
          dueDate: typeof payload.dueDate === "string" ? payload.dueDate : null,
          status: payload.status === "done" || payload.status === "active" ? payload.status : "planned",
          position: Number.isSafeInteger(payload.position) ? Number(payload.position) : demoSeq,
          createdAt: demoNow(),
          updatedAt: demoNow(),
          seq: demoSeq,
        };
        demo.milestones = [milestone, ...demo.milestones];
        return { milestone };
      }
    }
    if (method === "PATCH") {
      demo.roadmaps = demo.roadmaps.map((candidate) =>
        candidate.id === id ? { ...candidate, ...payload, updatedAt: demoNow() } : candidate,
      );
      return { roadmap: demo.roadmaps.find((candidate) => candidate.id === id) };
    }
    if (method === "DELETE") {
      demo.roadmaps = demo.roadmaps.filter((candidate) => candidate.id !== id);
      demo.milestones = demo.milestones.filter((milestone) => milestone.roadmapId !== id);
      return { ok: true };
    }
    return { roadmap };
  }

  if (root === "milestones") {
    if (method === "PATCH") {
      demo.milestones = demo.milestones.map((milestone) =>
        milestone.id === id
          ? {
              ...milestone,
              ...payload,
              status:
                payload.status === "done" || payload.status === "active" || payload.status === "planned"
                  ? payload.status
                  : milestone.status,
              updatedAt: demoNow(),
            }
          : milestone,
      );
      return { milestone: demo.milestones.find((milestone) => milestone.id === id) };
    }
    if (method === "DELETE") {
      demo.milestones = demo.milestones.filter((milestone) => milestone.id !== id);
      return { ok: true };
    }
    return { milestone: demo.milestones.find((milestone) => milestone.id === id) };
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

  /** The account as it now stands; the dialog asks on open for the quota. */
  authRefresh: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_refresh")
      : Promise.resolve({
          signedIn: true,
          state: "signed_in",
          email: "you@example.com",
          name: "You",
          plan: "pro",
          cloudSync: demoCloudSync,
          quota: null,
        }),

  getSettings: (): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("get_settings")
      : Promise.resolve({
          projectsDir: "",
          advancedMode: false,
          plan: "pro",
          cloudSync: demoCloudSync,
          customProvider: demoProvider,
        }),

  /** The account-wide switch: turning it off here turns it off in Hook too. */
  async setCloudSync(enabled: boolean): Promise<SettingsView> {
    if (!isTauri()) demoCloudSync = enabled;
    return isTauri()
      ? invoke<SettingsView>("set_cloud_sync", { enabled })
      : {
          projectsDir: "",
          advancedMode: false,
          plan: "pro",
          cloudSync: demoCloudSync,
          customProvider: demoProvider,
        };
  },

  async setCustomProvider(
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<SettingsView> {
    if (!isTauri()) demoProvider = { baseUrl, model, hasKey: true };
    return isTauri()
      ? invoke<SettingsView>("set_custom_provider", { baseUrl, apiKey, model })
      : {
          projectsDir: "",
          advancedMode: false,
          plan: "pro",
          cloudSync: demoCloudSync,
          customProvider: demoProvider,
        };
  },

  async clearCustomProvider(): Promise<SettingsView> {
    if (!isTauri()) demoProvider = null;
    return isTauri()
      ? invoke<SettingsView>("clear_custom_provider")
      : {
          projectsDir: "",
          advancedMode: false,
          plan: "pro",
          cloudSync: demoCloudSync,
          customProvider: demoProvider,
        };
  },

  customModels: (baseUrl: string, apiKey: string): Promise<string[]> =>
    isTauri()
      ? invoke<string[]>("custom_models", {
          baseUrl: baseUrl || null,
          apiKey: apiKey || null,
        })
      : Promise.resolve(["gpt-4o-mini", "gpt-4o", "o3-mini"]),

  syncStatus: (): Promise<SyncView> =>
    isTauri()
      ? invoke<SyncView>("sync_status")
      : Promise.resolve({
          enabled: demoCloudSync,
          available: true,
          reason: demoCloudSync ? null : "off",
          state: demoCloudSync ? "idle" : "off",
          cursor: 0,
          pending: 0,
          lastSyncAt: 0,
          message: null,
        }),

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
  createBoard: (
    projectId: string,
    name: string,
    folderId: string | null = null,
    options: { description?: string; columns?: Column[]; view?: "table" | "board" } = {},
  ) =>
    call<{ board: Board }>("POST", `/projects/${projectId}/boards`, {
      name,
      folderId,
      ...options,
    }),
  updateBoard: (
    id: string,
    patch: Partial<Pick<Board, "name" | "description" | "folderId" | "columns" | "view">>,
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
      fields?: Record<string, unknown>;
      position?: number;
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
    patch: {
      title?: string;
      markdown?: string;
      baseRev?: number;
      folderId?: string | null;
    },
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

  roadmaps: (projectId: string) =>
    call<{ roadmaps: Roadmap[] }>("GET", `/projects/${projectId}/roadmaps`),
  roadmap: (id: string) => call<{ roadmap: Roadmap }>("GET", `/roadmaps/${id}`),
  createRoadmap: (
    projectId: string,
    roadmap: { name: string; description?: string; folderId?: string | null },
  ) => call<{ roadmap: Roadmap }>("POST", `/projects/${projectId}/roadmaps`, roadmap),
  updateRoadmap: (id: string, patch: Partial<Roadmap>) =>
    call<{ roadmap: Roadmap }>("PATCH", `/roadmaps/${id}`, patch),
  deleteRoadmap: (id: string) => call<{ ok: true }>("DELETE", `/roadmaps/${id}`),
  brainstorms: (projectId: string) =>
    call<{ brainstorms: Brainstorm[] }>("GET", `/projects/${projectId}/brainstorms`),
  brainstormIdeas: (projectId: string) =>
    call<{ ideas: BrainstormIdea[] }>("GET", `/projects/${projectId}/brainstorm-ideas`),
  brainstorm: (id: string) =>
    call<{ brainstorm: Brainstorm }>("GET", `/brainstorms/${id}`),
  createBrainstorm: (
    projectId: string,
    brainstorm: { name: string; description?: string; folderId?: string | null },
  ) => call<{ brainstorm: Brainstorm }>("POST", `/projects/${projectId}/brainstorms`, brainstorm),
  updateBrainstorm: (id: string, patch: Partial<Brainstorm>) =>
    call<{ brainstorm: Brainstorm }>("PATCH", `/brainstorms/${id}`, patch),
  deleteBrainstorm: (id: string) => call<{ ok: true }>("DELETE", `/brainstorms/${id}`),
  createBrainstormIdea: (brainstormId: string, text: string) =>
    call<{ idea: BrainstormIdea }>("POST", `/brainstorms/${brainstormId}/ideas`, { text }),
  updateBrainstormIdea: (id: string, patch: { text?: string; position?: number }) =>
    call<{ idea: BrainstormIdea }>("PATCH", `/ideas/${id}`, patch),
  deleteBrainstormIdea: (id: string) =>
    call<{ ok: true }>("DELETE", `/ideas/${id}`),
  milestones: (projectId: string) =>
    call<{ milestones: Milestone[] }>("GET", `/projects/${projectId}/milestones`),
  milestone: (id: string) => call<{ milestone: Milestone }>("GET", `/milestones/${id}`),
  roadmapsMilestones: (roadmapId: string) =>
    call<{ milestones: Milestone[] }>("GET", `/roadmaps/${roadmapId}/milestones`),
  createMilestone: (
    roadmapId: string,
    milestone: {
      title: string;
      description?: string;
      dueDate?: string | null;
      status?: Milestone["status"];
      position?: number;
    },
  ) => call<{ milestone: Milestone }>("POST", `/roadmaps/${roadmapId}/milestones`, milestone),
  updateMilestone: (id: string, patch: Partial<Milestone>) =>
    call<{ milestone: Milestone }>("PATCH", `/milestones/${id}`, patch),
  deleteMilestone: (id: string) => call<{ ok: true }>("DELETE", `/milestones/${id}`),

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

/** The answer to "export this window as a PDF". Mirrors `PdfExport` in hook-core. */
export interface PdfExport {
  /** The file that was written, when one was. */
  path: string | null;
  /**
   * Whether this build writes the PDF itself. False means there is no silent
   * writer here (a browser, or a platform without one), so the caller prints
   * through the system dialog instead.
   */
  direct: boolean;
}

/**
 * Write the page the window is showing to a PDF the person names.
 *
 * The page is what prints, not what is being edited: the caller puts the
 * document on the sheet first (`pdf.ts`), the print stylesheet decides the
 * rest, and `pageHeight` — one page's height in inches, margins included — is
 * what makes it one page instead of a stack. `null` leaves the sheets to the
 * writer.
 */
export async function exportPdf(
  suggestedName: string,
  pageHeight: number | null,
): Promise<PdfExport> {
  if (!isTauri()) return { path: null, direct: false };
  return invoke<PdfExport>("export_pdf", { suggestedName, pageHeight });
}
