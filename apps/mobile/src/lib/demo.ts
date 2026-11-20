import type {
  AppInfo,
  AuthView,
  Chat,
  ChatMeta,
  Message,
  PreviewEvent,
  SettingsView,
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

function listMeta(): ChatMeta[] {
  return [...chats]
    .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
    .map((chat) => chat.meta);
}

export const demo = {
  async appInfo(): Promise<AppInfo> {
    return { version: "0.1.0-preview", product: "mobile" };
  },

  async authStatus(): Promise<AuthView> {
    return {
      signedIn: true,
      state: "signed_in",
      email: "you@example.com",
      name: "Sam",
      userCode: null,
      verificationUrl: null,
      message: null,
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
    };
  },

  async listChats(): Promise<ChatMeta[]> {
    return listMeta();
  },

  async getChat(chatId: string): Promise<Chat> {
    const chat = chats.find((item) => item.meta.id === chatId);
    return chat ? structuredClone(chat) : { meta: listMeta()[0], messages: [] };
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

  async getSettings(): Promise<SettingsView> {
    return { projectsDir: "", advancedMode };
  },

  async setAdvancedMode(enabled: boolean): Promise<SettingsView> {
    advancedMode = enabled;
    return { projectsDir: "", advancedMode };
  },

  async syncStatus(): Promise<SyncView> {
    return {
      enabled: true,
      state: "idle",
      cursor: 42,
      pending: 0,
      lastSyncAt: Date.now() - 40_000,
      message: null,
    };
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
