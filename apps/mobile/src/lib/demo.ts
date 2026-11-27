import type {
  AppInfo,
  AuthView,
  Chat,
  ChatMeta,
  CustomProvider,
  DeviceView,
  DevicesView,
  Message,
  PreviewEvent,
  RemoteFolder,
  RemoteFolders,
  RemoteProject,
  RemoteTarget,
  SettingsView,
  SlashCommand,
  StreamEvent,
  SyncView,
} from "./types";

/**
 * What `pnpm --dir apps/mobile dev` shows in a browser.
 *
 * There is no Rust behind the page, so this answers with the same shapes the
 * backend sends — including a live streaming reply and a Workspace board in the
 * preview sheet. It exists so the phone layout can be designed and reviewed
 * without an emulator, exactly like the desktop app's `mock.ts`.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEMO_PHONE_ID = "demo-phone";

const DEMO_REMOTE_PROJECTS: RemoteProject[] = [
  { project: "hook", description: "The desktop and phone products", git: true },
  { project: "website", description: "Landing page", git: true },
];

/** The demo host's folders, so the browser can be walked in a plain browser. */
const DEMO_FOLDER_TREE: Record<string, string[]> = {
  "C:\\": ["Program Files", "src", "Users"],
  "C:\\Users": ["you"],
  "C:\\Users\\you": ["Documents", "Hook Projects", "src"],
  "C:\\Users\\you\\Documents": ["notes"],
  "C:\\Users\\you\\Hook Projects": ["hook", "website"],
  "C:\\Users\\you\\Hook Projects\\hook": ["crates", "packages"],
  "C:\\Users\\you\\src": ["api", "app"],
};

const DEMO_FOLDER_PLACES: RemoteFolder[] = [
  { name: "Home", path: "C:\\Users\\you", pinned: false },
  { name: "Projects", path: "C:\\Users\\you\\Hook Projects", pinned: false },
  { name: "C:", path: "C:\\", pinned: false },
];

/** What the demo host has starred; the browser walk shows the same list. */
let DEMO_PINNED_FOLDERS: string[] = [];

function demoFolderListing(path: string | null): RemoteFolders {
  const starred = (candidate: string) =>
    DEMO_PINNED_FOLDERS.some(
      (entry) => entry.toLowerCase() === candidate.toLowerCase(),
    );
  if (!path) {
    const shortcuts = DEMO_PINNED_FOLDERS.map((pinned) => {
      const name = pinned.replace(/\\+$/, "").split("\\").pop() || pinned;
      return {
        name: DEMO_FOLDER_PLACES.find((place) => place.path === pinned)?.name ?? name,
        path: pinned,
        pinned: true,
      };
    });
    return {
      path: null,
      parent: null,
      entries: [
        ...shortcuts,
        ...structuredClone(DEMO_FOLDER_PLACES).filter(
          (place) => !starred(place.path),
        ),
      ],
      truncated: false,
    };
  }
  const trimmed = path.endsWith("\\") ? path.slice(0, -1) : path;
  const parent = trimmed.includes("\\")
    ? trimmed.slice(0, trimmed.lastIndexOf("\\"))
    : null;
  const separator = path.endsWith("\\") ? "" : "\\";
  return {
    path,
    parent: parent === "C:" ? "C:\\" : parent,
    entries: (DEMO_FOLDER_TREE[path] ?? []).map((name) => ({
      name,
      path: `${path}${separator}${name}`,
      pinned: starred(`${path}${separator}${name}`),
    })),
    truncated: false,
  };
}

const demoDevices: DeviceView[] = [
  {
    id: DEMO_PHONE_ID,
    name: "This phone",
    kind: "mobile",
    platform: "android",
    arch: "aarch64",
    appVersion: "0.1.3",
    product: "mobile",
    canHost: false,
    online: true,
    hostOnline: false,
    role: "controller",
    remoteAllowed: false,
    lastSeen: new Date().toISOString(),
    capabilities: { codingAgents: false },
    specs: null,
  },
  {
    id: "demo-desktop",
    name: "Ben's PC",
    kind: "desktop",
    platform: "windows",
    arch: "x86_64",
    appVersion: "0.4.0",
    product: "chat",
    canHost: true,
    online: true,
    hostOnline: true,
    role: "host",
    remoteAllowed: true,
    lastSeen: new Date().toISOString(),
    capabilities: { codingAgents: true },
    specs: { cpuCores: 16, projects: 3 },
  },
  {
    id: "demo-cloud",
    name: "Cloud Linux",
    kind: "headless",
    platform: "linux",
    arch: "x86_64",
    appVersion: "0.1.0",
    product: "headless",
    canHost: true,
    online: false,
    hostOnline: false,
    role: "controller",
    remoteAllowed: true,
    lastSeen: new Date(Date.now() - 90 * 60_000).toISOString(),
    capabilities: { codingAgents: true },
    specs: { cpuCores: 4, projects: 1 },
  },
];

const listeners = new Set<(chatId: string, event: StreamEvent) => void>();
const previewListeners = new Set<(event: PreviewEvent) => void>();

function emit(chatId: string, event: StreamEvent) {
  for (const listener of listeners) listener(chatId, event);
}

const board = {
  id: "board_1",
  projectId: "prj_1",
  name: "Q1 launch",
  description: "Everything that has to ship before the release.",
  // The shape `workspace_preview` returns: the board's columns are attributes,
  // and the one of type "status" carries the options a card moves between.
  columns: [
    {
      id: "status",
      name: "Status",
      type: "status",
      options: [
        { id: "todo", label: "To do" },
        { id: "doing", label: "In progress" },
        { id: "done", label: "Done" },
      ],
    },
    { id: "assignee", name: "Assignee", type: "person" },
  ],
};

const tasks = [
  {
    id: "task_1",
    projectId: "prj_1",
    boardId: "board_1",
    title: "Ship the pricing page",
    description: "Final copy, one screenshot of the studio, and the annual toggle.",
    status: "doing",
    updatedAt: Date.now(),
  },
  {
    id: "task_2",
    projectId: "prj_1",
    boardId: "board_1",
    title: "Write the release notes",
    description: "",
    status: "todo",
    updatedAt: Date.now(),
  },
  {
    id: "task_3",
    projectId: "prj_1",
    boardId: "board_1",
    title: "Fix the invoice totals",
    description: "",
    status: "done",
    updatedAt: Date.now(),
  },
];

let chats: Chat[] = [
  {
    meta: {
      id: "chat_demo",
      title: "What is left on the Q1 board?",
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 60_000,
      pinned: false,
      messageCount: 2,
      preview: "Two cards are still open.",
    },
    messages: [
      {
        id: "m1",
        role: "user",
        content: "What is left on the Q1 board?",
        status: "complete",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "**Two cards are still open.**\n\n- *Ship the pricing page* — in progress\n- *Write the release notes* — not started\n\n*Fix the invoice totals* is done.",
        status: "complete",
      },
    ],
  },
  {
    meta: {
      id: "chat_brand",
      title: "Tighten the brand brief",
      createdAt: Date.now() - 86_400_000,
      updatedAt: Date.now() - 80_000_000,
      pinned: false,
      messageCount: 2,
      preview: "Warmer, less corporate.",
    },
    messages: [
      {
        id: "b1",
        role: "user",
        content: "Tighten the brand brief.",
        status: "complete",
      },
      {
        id: "b2",
        role: "assistant",
        content: "Warmer, less corporate, and one sentence per idea.",
        status: "complete",
      },
    ],
  },
];

let seq = 10;
let advancedMode = false;

/** Design-time account state. `?plan=free`, `?sync=off` preview the other side. */
const demoParams = new URLSearchParams(window.location.search);
const demoPlan: string = demoParams.get("plan") === "free" ? "free" : "pro";
let demoCloudSync = demoParams.get("sync") !== "off";
let demoProvider: CustomProvider | null =
  demoParams.get("byok") === "1"
    ? { baseUrl: "https://api.example.test/v1", model: "gpt-4o-mini", hasKey: true }
    : null;

const demoAccount = (): Pick<AuthView, "plan" | "cloudSync" | "quota"> => ({
  plan: demoPlan,
  cloudSync: demoCloudSync,
  quota:
    demoPlan === "free"
      ? { limit: 100, used: 12, remaining: 88, resetAt: null }
      : null,
});

function listMeta(): ChatMeta[] {
  return [...chats]
    .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
    .map((chat) => chat.meta);
}

/**
 * The phone's sign-in screen, previewed in a browser.
 *
 * `?login=1` opens signed out, the same switch the desktop's demo has;
 * `?login=pending` opens on the code, so the waiting half can be looked at
 * without an account in flight.
 */
function demoLogin(): "out" | "pending" | null {
  const value = new URLSearchParams(location.search).get("login");
  if (value === null) return null;
  return value === "pending" ? "pending" : "out";
}

export const demo = {
  async appInfo(): Promise<AppInfo> {
    return { version: "0.1.0-preview", product: "mobile" };
  },

  async authStatus(): Promise<AuthView> {
    const login = demoLogin();
    if (login === "pending") return this.authLogin();
    if (login === "out") return this.authLogout();
    return {
      signedIn: true,
      state: "signed_in",
      email: "you@example.com",
      name: "Sam",
      userCode: null,
      verificationUrl: null,
      message: null,
      ...demoAccount(),
    };
  },

  async authLogin(): Promise<AuthView> {
    await sleep(200);
    return {
      signedIn: false,
      state: "pending",
      email: null,
      name: null,
      userCode: "K7QM-2XPD",
      verificationUrl: "https://hookcode.io/authorize?code=K7QM-2XPD",
      message: null,
      ...demoAccount(),
    };
  },

  async authCancelLogin(): Promise<AuthView> {
    return this.authStatus();
  },

  async authLogout(): Promise<AuthView> {
    return {
      signedIn: false,
      state: "signed_out",
      email: null,
      name: null,
      userCode: null,
      verificationUrl: null,
      message: null,
      ...demoAccount(),
    };
  },

  async listChats(): Promise<ChatMeta[]> {
    return listMeta();
  },

  async getChat(chatId: string): Promise<Chat> {
    const chat = chats.find((item) => item.meta.id === chatId);
    return chat ? structuredClone(chat) : { meta: listMeta()[0], messages: [] };
  },

  async fetchRemoteChat(chatId: string): Promise<Chat> {
    const chat = chats.find((item) => item.meta.id === chatId);
    if (!chat) throw new Error("Chat not found");
    if (chat.meta.remote && chat.messages.length === 0) {
      chat.messages = [
        {
          id: `m_${(seq += 1)}`,
          role: "assistant",
          content:
            "I am on the desktop, in that project. This transcript was fetched over the relay and cached here; the folder and the engine stay there.",
          createdAt: Date.now(),
          status: "complete",
        },
      ];
      chat.meta.messageCount = 1;
      chat.meta.updatedAt = Date.now();
    }
    return structuredClone(chat);
  },

  async createRemoteCodingChat(
    deviceId: string,
    target: RemoteTarget,
  ): Promise<ChatMeta> {
    const device = demoDevices.find((entry) => entry.id === deviceId);
    if (!device) throw new Error("That machine is no longer on this account.");
    const title =
      target.folder?.split(/[\\/]/).filter(Boolean).pop() ??
      target.project ??
      "Coding agent";
    const meta: ChatMeta = {
      id: `chat_${(seq += 1)}`,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      messageCount: 0,
      preview: "",
      kind: "coding",
      deviceId,
      deviceName: device.name,
      remote: true,
      stubState: "idle",
    };
    chats = [{ meta, messages: [] }, ...chats];
    return structuredClone(meta);
  },

  async remoteProjects(_deviceId: string): Promise<RemoteProject[]> {
    return structuredClone(DEMO_REMOTE_PROJECTS);
  },

  async remoteFolders(
    _deviceId: string,
    path: string | null,
  ): Promise<RemoteFolders> {
    return demoFolderListing(path);
  },

  async pinRemoteFolder(
    _deviceId: string,
    path: string,
    pinned: boolean,
  ): Promise<string[]> {
    const known = DEMO_PINNED_FOLDERS.some(
      (entry) => entry.toLowerCase() === path.toLowerCase(),
    );
    if (pinned && !known) DEMO_PINNED_FOLDERS.push(path);
    if (!pinned) {
      DEMO_PINNED_FOLDERS = DEMO_PINNED_FOLDERS.filter(
        (entry) => entry.toLowerCase() !== path.toLowerCase(),
      );
    }
    return [...DEMO_PINNED_FOLDERS];
  },

  async createRemoteProject(
    _deviceId: string,
    name: string,
    description: string,
  ): Promise<RemoteProject> {
    const clean = name.trim();
    if (!clean) throw new Error("Write a project name first.");
    if (DEMO_REMOTE_PROJECTS.some((entry) => entry.project === clean)) {
      throw new Error(`A project named "${clean}" already exists.`);
    }
    const project: RemoteProject = {
      project: clean,
      description: description.trim(),
      git: false,
    };
    DEMO_REMOTE_PROJECTS.push(project);
    return structuredClone(project);
  },

  async renameChat(): Promise<void> {},
  async setPinned(): Promise<void> {},
  async deleteChat(): Promise<void> {},
  async stopStream(): Promise<void> {},
  async noop(): Promise<void> {},

  async sendMessage(chatId: string | null, text: string): Promise<string> {
    const id = chatId ?? `chat_${(seq += 1)}`;
    let chat = chats.find((item) => item.meta.id === id);
    if (!chat) {
      chat = {
        meta: {
          id,
          title: text.slice(0, 60) || "New chat",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pinned: false,
          messageCount: 0,
          preview: "",
        },
        messages: [],
      };
      chats = [chat, ...chats];
    }
    const user: Message = {
      id: `m${(seq += 1)}`,
      role: "user",
      content: text,
      status: "complete",
    };
    const reply: Message = {
      id: `m${(seq += 1)}`,
      role: "assistant",
      content: "",
      status: "streaming",
    };
    chat.messages = [...chat.messages, user, reply];
    chat.meta.updatedAt = Date.now();
    chat.meta.messageCount = chat.messages.length;
    const started = chat.messages.map((message) => ({ ...message }));
    emit(id, { kind: "started", messages: started, meta: chat.meta });

    emit(id, { kind: "activity", label: "Checking the Q1 board" });

    const answer = [
      "Here is the **Q1 board** as it stands.\n\n",
      "Two cards are still open, and both are on the critical path:\n\n",
      "| Card | Where |\n| --- | --- |\n",
      "| Ship the pricing page | In progress |\n",
      "| Write the release notes | To do |\n\n",
      "I put the board in the preview so you can see the columns.",
    ];
    for (const [index, word] of answer.join("").split(/(\s+)/).entries()) {
      await sleep(index === 0 ? 30 : 24);
      emit(id, { kind: "delta", text: word });
    }
    await sleep(400);

    const done: Message = { ...reply, content: answer.join(""), status: "complete" };
    chat.messages[chat.messages.length - 1] = done;
    chat.meta.preview = "Here is the Q1 board as it stands.";
    emit(id, { kind: "activity", label: null });
    emit(id, {
      kind: "done",
      messages: chat.messages.map((message) => ({ ...message })),
    });

    for (const listener of previewListeners) {
      listener({
        active: true,
        chatId: id,
        kind: "board",
        board,
        tasks,
        title: board.name,
        open: true,
      });
    }
    return id;
  },

  async slashCommands(): Promise<SlashCommand[]> {
    if (!advancedMode) return [];
    return [
      {
        name: "compact",
        summary: "Summarize the older turns and continue from the summary",
        usage: "/compact [what to keep]",
        scope: "any",
      },
    ];
  },

  async getSettings(): Promise<SettingsView> {
    return {
      projectsDir: "",
      advancedMode,
      plan: demoPlan,
      cloudSync: demoCloudSync,
      customProvider: demoProvider,
    };
  },

  async setAdvancedMode(enabled: boolean): Promise<SettingsView> {
    advancedMode = enabled;
    return this.getSettings();
  },

  async setCloudSync(enabled: boolean): Promise<SettingsView> {
    if (demoPlan === "free" && enabled) {
      throw new Error("Cloud sync is part of a paid plan.");
    }
    demoCloudSync = enabled;
    return this.getSettings();
  },

  async setCustomProvider(
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<SettingsView> {
    if (!baseUrl.trim() || !model.trim()) {
      throw new Error("Enter an endpoint and a model name.");
    }
    if (!apiKey.trim() && !demoProvider?.hasKey) {
      throw new Error("Enter the API key for this endpoint.");
    }
    demoProvider = { baseUrl: baseUrl.trim(), model: model.trim(), hasKey: true };
    return this.getSettings();
  },

  async clearCustomProvider(): Promise<SettingsView> {
    demoProvider = null;
    return this.getSettings();
  },

  async customModels(baseUrl: string, apiKey: string): Promise<string[]> {
    if (!baseUrl.trim()) throw new Error("Enter the endpoint first.");
    if (!apiKey.trim() && !demoProvider?.hasKey) {
      throw new Error("Enter the API key first.");
    }
    await sleep(300);
    return ["gpt-4o-mini", "gpt-4o", "llama-3.3-70b-instruct", "o3-mini"];
  },

  async syncStatus(): Promise<SyncView> {
    const available = demoPlan !== "free";
    const enabled = available && demoCloudSync;
    return {
      enabled,
      available,
      reason: !available ? "free" : !demoCloudSync ? "off" : null,
      state: enabled ? "idle" : "off",
      cursor: enabled ? 42 : 0,
      pending: 0,
      lastSyncAt: enabled ? Date.now() - 40_000 : 0,
      message: null,
    };
  },

  async devices(): Promise<DevicesView> {
    return {
      state: "online",
      message: null,
      error: null,
      selfId: DEMO_PHONE_ID,
      selfName: "This phone",
      devices: demoDevices.map((device) => ({ ...device })),
    };
  },

  async renameDevice(deviceId: string, name: string): Promise<DeviceView> {
    const device = demoDevices.find((entry) => entry.id === deviceId);
    if (!device) throw new Error("That machine is no longer on this account.");
    device.name = name.trim().slice(0, 60) || device.name;
    return { ...device };
  },

  async setDeviceRemote(deviceId: string, allowed: boolean): Promise<DeviceView> {
    const device = demoDevices.find((entry) => entry.id === deviceId);
    if (!device) throw new Error("That machine is no longer on this account.");
    device.remoteAllowed = allowed;
    return { ...device };
  },

  async removeDevice(deviceId: string): Promise<void> {
    const at = demoDevices.findIndex((entry) => entry.id === deviceId);
    if (at >= 0) demoDevices.splice(at, 1);
  },

  async wsRequest(
    _method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    _body?: unknown,
  ): Promise<unknown> {
    if (path === "/projects") {
      return {
        projects: [
          {
            id: "prj_1",
            name: "Hook",
            description: "The desktop app and its account service.",
          },
        ],
      };
    }
    if (path === "/projects/prj_1/boards") return { boards: [board] };
    if (path === "/boards/board_1/tasks") return { tasks };
    return {};
  },

  async previewState(): Promise<PreviewEvent | null> {
    return null;
  },

  async openUrl(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  },

  onChat(listener: (chatId: string, event: StreamEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  onPreview(listener: (event: PreviewEvent) => void): () => void {
    previewListeners.add(listener);
    return () => previewListeners.delete(listener);
  },
};
