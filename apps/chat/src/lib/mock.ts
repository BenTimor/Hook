/**
 * In-memory backend used when the UI runs in a plain browser (`pnpm dev`).
 * It lets the interface be designed and reviewed without the Tauri shell, and
 * gives the real app a graceful no-runtime fallback.
 */
import type {
  AgentsOverview,
  AppInfo,
  AuthView,
  Chat,
  ChatMeta,
  CustomProvider,
  DeviceView,
  DevicesView,
  ImportPreview,
  ImportSummary,
  MemoryEntry,
  MemoryView,
  AgentTranscript,
  Message,
  PlanStep,
  PreviewView,
  RemoteProject,
  SearchHit,
  SettingsView,
  StreamEvent,
  SyncView,
  UpdateInfo,
} from "./types";

const HOUR = 3_600_000;
const DAY = 86_400_000;

let seq = 100;
const id = (prefix: string) => `${prefix}${++seq}-mock`;

const REPLY = `Here's how I'd think about it.

### Start with the seam

Put the transport behind a single async generator, so the UI never knows whether tokens came from a socket, a queue, or a test fixture:

\`\`\`ts
async function* streamChat(input: Request): AsyncGenerator<Delta> {
  const res = await fetch(input.url, { signal: input.signal });
  for await (const chunk of readSse(res.body!)) {
    yield parseDelta(chunk);
  }
}
\`\`\`

The important part is that **abort is a first-class input**, not a flag you remember to check.

### What to watch for

| Concern | Why it bites |
| --- | --- |
| Backpressure | React re-renders faster than the network drips tokens |
| Partial UTF-8 | Splitting a chunk mid-codepoint corrupts emoji |
| Reconnect | A dropped stream must keep the partial reply |

If you handle those three, the rest is styling.`;

const SHORT_REPLY = `Two things are fighting here.

1. Your grid track is \`1fr\`, which has an implicit minimum of \`auto\` — so a long unbroken string inflates the column.
2. The container has \`overflow: hidden\`, so the overflow is clipped rather than visible.

Use \`minmax(0, 1fr)\` and the layout collapses back to the width you expected.`;

const DEMO_REPLY = `A few directions worth exploring:

- **Frosted rail** — one translucent sheet, \`backdrop-filter: blur(28px)\`, no shadow inside.
- **Hairline separation** — a single 1px rule instead of drop shadows reads calmer.
- **Sticky active state** — the active row keeps a soft white plate, everything else stays flat.

I'd start with the rail, then add depth only where something is interactive.`;

function msg(role: "user" | "assistant", content: string, at: number): Message {
  return { id: id("m"), role, content, createdAt: at, status: "complete" };
}

/** A stand-in page so the panel can be designed in the browser preview. */
const PREVIEW_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 36px 56px; background: #f5efe5; color: #24241e;
    font: 15px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
  }
  .eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #736d60; }
  h1 { margin: 8px 0 6px; font-size: 34px; letter-spacing: -.03em; }
  p.lede { margin: 0 0 30px; color: #5f5a51; max-width: 44ch; }
  .cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
  .card {
    background: #fffdf9; border: 1px solid rgba(63,57,43,.1); border-radius: 18px;
    padding: 20px 18px; box-shadow: 0 1px 2px rgba(63,57,43,.04), 0 10px 28px -16px rgba(63,57,43,.22);
  }
  .card.dark { background: #283b31; color: #f5efe5; border-color: transparent; }
  .name { font-weight: 600; font-size: 13px; }
  .card p { margin: 8px 0 0; font-size: 12.5px; color: #5f5a51; }
  .card.dark p { color: rgba(245,239,229,.78); }
  .cta {
    display: inline-block; margin-top: 26px; padding: 10px 16px; border-radius: 10px;
    background: #283b31; color: #f5efe5; font-size: 13px; font-weight: 500;
  }
</style>
</head>
<body>
  <div class="eyebrow">New release</div>
  <h1>A calmer way to ship.</h1>
  <p class="lede">A live preview of the page the coding agent is building. Every save in the project refreshes this frame.</p>
  <div class="cards">
    <div class="card"><div class="name">Plan in plain language</div><p>The agent turns a brief into a short checklist you can watch and steer.</p></div>
    <div class="card dark"><div class="name">See it as it is built</div><p>The page reloads on every save, so the work is visible before it is finished.</p></div>
    <div class="card"><div class="name">Keep it on your machine</div><p>Projects, conversations and the coding engine stay on your PC.</p></div>
  </div>
  <span class="cta">See what's new</span>
</body>
</html>`;

const PREVIEW_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PREVIEW_HTML)}`;

/**
 * A Workspace board, task and document for the design-time preview
 * (`?preview=board`). The shapes are the ones `workspace_preview` returns, so
 * the panel can be laid out without a coding agent and without a signed-in
 * account.
 */
const DEMO_BOARD = {
  id: "board_demo",
  projectId: "prj_demo",
  name: "Q1 launch",
  description: "Everything that has to ship before the release.",
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
  ],
};

const DEMO_TASKS = [
  {
    id: "task_1",
    projectId: "prj_demo",
    boardId: "board_demo",
    title: "Ship the pricing page",
    description: "Final copy, one screenshot of the studio, and the annual toggle.",
    status: "doing",
    updatedAt: Date.now(),
  },
  {
    id: "task_2",
    projectId: "prj_demo",
    boardId: "board_demo",
    title: "Write the release notes",
    description: "",
    status: "todo",
    updatedAt: Date.now(),
  },
  {
    id: "task_3",
    projectId: "prj_demo",
    boardId: "board_demo",
    title: "Fix the invoice totals",
    description: "",
    status: "done",
    updatedAt: Date.now(),
  },
];


function build(): Record<string, Chat> {
  const now = Date.now();
  const chats: Record<string, Chat> = {};

  const add = (
    chatId: string,
    title: string,
    updatedAt: number,
    pinned: boolean,
    messages: Message[],
    pinnedAt?: number,
  ) => {
    const first = messages[0]?.createdAt ?? updatedAt;
    chats[chatId] = {
      meta: {
        id: chatId,
        title,
        createdAt: first,
        updatedAt,
        pinned,
        pinnedAt,
        messageCount: messages.length,
        preview: messages.filter((m) => m.role === "assistant").at(-1)?.content.slice(0, 160) ?? "",
      },
      messages,
    };
  };

  add("c8", "Build the launch page", now - 4 * 60_000, false, [
    msg(
      "user",
      "Build a launch page for the new release, then show me what it looks like.",
      now - 5 * 60_000,
    ),
    // Advanced-mode preview: a turn that thought, read a file and ran a
    // command before answering. Hidden in the simple view, folded in advanced.
    {
      id: "c8-a1",
      role: "assistant",
      content: "",
      reasoning:
        "The project is Astro with a shared layout. I should read the current page first so the launch page uses the same structure instead of inventing a second one.",
      createdAt: now - 4 * 60_000 - 20_000,
      status: "complete",
      hidden: true,
      toolCalls: [
        {
          id: "call_c8_read",
          name: "read",
          arguments: '{"path":"src/pages/index.astro"}',
        },
        {
          id: "call_c8_build",
          name: "bash",
          arguments: '{"command":"pnpm build","timeout":120}',
        },
      ],
    },
    {
      id: "c8-t1",
      role: "tool",
      content:
        "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title=\"Site\">…",
      createdAt: now - 4 * 60_000 - 12_000,
      status: "complete",
      hidden: true,
      toolCallId: "call_c8_read",
    },
    {
      id: "c8-t2",
      role: "tool",
      content:
        "vite v5.4.2 building for production…\n✓ 41 modules transformed.\n✓ built in 3.18s",
      createdAt: now - 4 * 60_000 - 6_000,
      status: "complete",
      hidden: true,
      toolCallId: "call_c8_build",
    },
    msg(
      "assistant",
      "I'll set up the project, build the page and put a live preview on the right as it comes together.",
      now - 4 * 60_000,
    ),
  ]);

  add(
    "c1",
    "Stateless auth without the session table",
    now - 9 * 60_000,
    true,
    [
      msg("user", "I want to drop the session table and move to stateless JWTs. What actually breaks?", now - 12 * 60_000),
      msg("assistant", REPLY, now - 9 * 60_000),
    ],
    now - 2 * DAY,
  );

  add(
    "c2",
    "Designing a glassmorphic sidebar",
    now - 2 * HOUR,
    false,
    [
      msg("user", "The sidebar feels heavy. How do I make it lighter without losing structure?", now - 2 * HOUR - 60_000),
      msg("assistant", DEMO_REPLY, now - 2 * HOUR),
    ],
  );

  add(
    "c3",
    "Why does my CSS grid overflow?",
    now - 5 * HOUR,
    false,
    [
      msg("user", "My grid column is 1fr but the content pushes it wider than the container. Why?", now - 5 * HOUR - 40_000),
      msg("assistant", SHORT_REPLY, now - 5 * HOUR),
    ],
  );

  add("c4", "Streaming SSE parsing in Rust", now - 26 * HOUR, false, [
    msg("user", "Show me a robust way to parse SSE frames from a byte stream.", now - 26 * HOUR - 30_000),
    msg("assistant", "You need a byte buffer, not a string buffer — otherwise a multi-byte character split across chunks turns into mojibake. Keep the buffer, scan for a blank line, then decode each frame as a whole.", now - 26 * HOUR),
  ]);

  add("c5", "Weekly planning — Q4 priorities", now - 3 * DAY, false, [
    msg("user", "Help me cut this list from nine priorities to three.", now - 3 * DAY - 20_000),
    msg("assistant", "Nine is a list, not a plan. Rank by *cost of delay* rather than importance and the top three usually pick themselves.", now - 3 * DAY),
  ]);

  add("c6", "Explaining CRDTs to a designer", now - 8 * DAY, false, [
    msg("user", "How would you explain CRDTs to someone who designs interfaces?", now - 8 * DAY - 15_000),
    msg("assistant", "Think of it as the difference between a shared whiteboard and a document that merges edits. Everyone can write at once, and the merge rule is decided in advance rather than by a referee.", now - 8 * DAY),
  ]);

  add("c7", "Naming this app", now - 22 * DAY, false, [
    msg("user", "Give me ten short names for a local AI chat app.", now - 22 * DAY - 25_000),
    msg("assistant", "Short, one syllable, and easy to type: Hook, Loom, Drift, Slate, Quill, Nook, Riff, Pane, Trace, Ember.", now - 22 * DAY),
  ]);

  return chats;
}

let chats = build();
const trashed: Record<string, Chat> = {};
const cancelled = new Set<string>();
const info: AppInfo = { version: "0.1.2" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rehash(chat: Chat) {
  chat.meta.messageCount = chat.messages.length;
  const last = [...chat.messages].reverse().find((m) => m.content.trim());
  chat.meta.preview = last?.content.slice(0, 160) ?? "";
}

function sorted(): ChatMeta[] {
  return Object.values(chats)
    .map((c) => c.meta)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
      return b.updatedAt - a.updatedAt;
    });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function plain(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*#>|_]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Data URLs for pictures staged in the browser preview. */
const previewImages = new Map<string, string>();

/** Design-time plan and account switches: `?plan=free`, `?sync=off`, `?used=99`.
 * The default is a paid account so nothing already previewed disappears. */
const mockParams = new URLSearchParams(window.location.search);
let MOCK_PLAN: string = mockParams.get("plan") === "free" ? "free" : "pro";
let MOCK_CLOUD_SYNC = mockParams.get("sync") !== "off";
const MOCK_USED = Math.min(
  100,
  Math.max(0, Number.parseInt(mockParams.get("used") ?? "12", 10) || 0),
);
/** A personal endpoint saved in this tab, for designing the Settings section. */
let MOCK_PROVIDER: CustomProvider | null =
  mockParams.get("byok") === "1"
    ? { baseUrl: "https://api.example.test/v1", model: "gpt-4o-mini", hasKey: true }
    : null;

const mockAuth: AuthView = {
  signedIn: true,
  state: "signed_in",
  email: "preview@hookcode.io",
  name: "Preview",
  userCode: null,
  verificationUrl: null,
  message: null,
  plan: MOCK_PLAN,
  cloudSync: MOCK_CLOUD_SYNC,
  quota:
    MOCK_PLAN === "free"
      ? { limit: 100, used: MOCK_USED, remaining: Math.max(0, 100 - MOCK_USED), resetAt: null }
      : null,
};

const demoLogin = () =>
  new URLSearchParams(window.location.search).get("login") === "1";

/** The advanced switch, kept in the tab so the browser preview behaves like
 * the desktop one. `?advanced=1` starts with it on. */
let MOCK_ADVANCED =
  new URLSearchParams(window.location.search).get("advanced") === "1";

/**
 * Browser preview only. The desktop keeps memories in the shared account folder
 * and syncs them; this list never leaves the tab, but it lets the Settings
 * screen be designed and clicked without the desktop shell.
 */
let MOCK_MEMORY_ENABLED = true;

const MOCK_MEMORY: MemoryEntry[] = [
  {
    id: "mem-pnpm",
    text: "Prefers pnpm over npm, and hates unnecessary dependencies.",
    kind: "feedback",
    pinned: true,
    chatId: null,
    createdAt: Date.now() - 40 * DAY,
    updatedAt: Date.now() - 40 * DAY,
    age: "2 months ago",
  },
  {
    id: "mem-style",
    text: "Likes short answers without preamble, and British spelling.",
    kind: "user",
    pinned: true,
    chatId: null,
    createdAt: Date.now() - 12 * DAY,
    updatedAt: Date.now() - 12 * DAY,
    age: "1 week ago",
  },
  {
    id: "mem-stack",
    text: "Works in TypeScript and Rust; the invoice parser is Python.",
    kind: "project",
    pinned: false,
    chatId: null,
    createdAt: Date.now() - 3 * DAY,
    updatedAt: Date.now() - 3 * DAY,
    age: "3 days ago",
  },
];

function memoryView(): MemoryView {
  return {
    enabled: MOCK_MEMORY_ENABLED,
    available: true,
    entries: [...MOCK_MEMORY].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
    ),
    pinned: MOCK_MEMORY.filter((entry) => entry.pinned).length,
    maxPinned: 40,
    maxEntries: 400,
  };
}

const MOCK_SELF_DEVICE = "dev-this-computer";

const MOCK_REMOTE_PROJECTS: RemoteProject[] = [
  { project: "hook", description: "The desktop and phone products", git: true },
  { project: "website", description: "Landing page", git: true },
];

const MOCK_DEVICES: DeviceView[] = [
  {
    id: MOCK_SELF_DEVICE,
    name: "This computer",
    kind: "desktop",
    platform: "windows",
    arch: "x86_64",
    appVersion: info.version,
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
    id: "dev-studio",
    name: "Studio Mac",
    kind: "desktop",
    platform: "macos",
    arch: "aarch64",
    appVersion: info.version,
    product: "chat",
    canHost: true,
    online: true,
    hostOnline: true,
    role: "host",
    remoteAllowed: true,
    lastSeen: new Date().toISOString(),
    capabilities: { codingAgents: true },
    specs: { cpuCores: 10, projects: 2 },
  },
  {
    id: "dev-phone",
    name: "Ben's iPhone",
    kind: "mobile",
    platform: "android",
    arch: "aarch64",
    appVersion: info.version,
    product: "mobile",
    canHost: false,
    online: true,
    hostOnline: false,
    role: "controller",
    remoteAllowed: false,
    lastSeen: new Date(Date.now() - 4 * 60_000).toISOString(),
    capabilities: { codingAgents: false },
    specs: null,
  },
  {
    id: "dev-cloud",
    name: "Cloud Linux",
    kind: "headless",
    platform: "linux",
    arch: "x86_64",
    appVersion: info.version,
    product: "headless",
    canHost: true,
    online: false,
    hostOnline: false,
    role: "controller",
    remoteAllowed: true,
    lastSeen: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    capabilities: { codingAgents: true },
    specs: { cpuCores: 4, projects: 1 },
  },
];

export const mock = {
  async appInfo() {
    return clone(info);
  },

  async checkUpdate(): Promise<UpdateInfo> {
    // Design-time preview: `?update=1` shows the optional banner,
    // `?update=required` the blocking dialog, `?update=store` the Store
    // banner, and `?update=store-required` the Store dialog.
    const demo = new URLSearchParams(window.location.search).get("update");
    const store = demo === "store" || demo === "store-required";
    const requiredDemo = demo === "required" || demo === "store-required";
    const idle = {
      current: info.version,
      latest: info.version,
      minimum: "0.0.0",
      channel: store ? ("store" as const) : ("direct" as const),
      available: false,
      required: false,
      notes: null,
      builtAt: null,
      commit: null,
      size: null,
    };
    if (!demo) return idle;
    return {
      ...idle,
      latest: "0.2.0",
      minimum: requiredDemo ? "0.2.0" : "0.1.0",
      channel: store ? ("store" as const) : ("direct" as const),
      available: true,
      required: requiredDemo,
      notes: "Updates install themselves now, and the task board keeps its place.",
      builtAt: new Date().toISOString(),
      commit: "abc1234",
      size: 29_400_000,
    };
  },

  async installUpdate(): Promise<void> {
    // The desktop app exits and hands over to the installer; the browser
    // preview stops at the progress state (see useUpdateStore).
    await sleep(30_000);
  },

  async openStoreUpdate(): Promise<void> {
    // Nothing to open outside the desktop shell; the preview only shows the
    // Store button and its copy.
  },

  async reportMessage(): Promise<void> {
    // The preview shows the dialog; sending it only needs a short pause.
    await sleep(250);
  },

  async reportContent(): Promise<void> {
    await sleep(250);
  },

  async authStatus(): Promise<AuthView> {
    // `?login=1` previews the sign-in window without the Tauri shell.
    return demoLogin()
      ? { ...mockAuth, signedIn: false, state: "signed_out", email: null }
      : { ...mockAuth };
  },

  async authLogin(): Promise<AuthView> {
    return { ...mockAuth };
  },

  async authCancelLogin(): Promise<AuthView> {
    return { ...mockAuth };
  },

  async authRefresh(): Promise<AuthView> {
    return { ...mockAuth };
  },

  async authLogout(): Promise<AuthView> {
    return { ...mockAuth, signedIn: false, state: "signed_out", email: null };
  },

  async listChats() {
    return clone(sorted());
  },

  async getChat(chatId: string): Promise<Chat> {
    const chat = chats[chatId];
    if (!chat) throw "Chat not found";
    return clone(chat);
  },

  async renameChat(chatId: string, title: string): Promise<ChatMeta> {
    const chat = chats[chatId];
    if (!chat) throw "Chat not found";
    chat.meta.title = title.trim() || "New chat";
    return clone(chat.meta);
  },

  async setPinned(chatId: string, pinned: boolean): Promise<ChatMeta> {
    const chat = chats[chatId];
    if (!chat) throw "Chat not found";
    chat.meta.pinned = pinned;
    chat.meta.pinnedAt = pinned ? Date.now() : undefined;
    return clone(chat.meta);
  },

  async deleteChat(chatId: string) {
    const chat = chats[chatId];
    if (chat) trashed[chatId] = chat;
    delete chats[chatId];
  },

  async restoreChat(chatId: string): Promise<ChatMeta> {
    const chat = trashed[chatId];
    if (!chat) throw "Chat not found";
    chats[chatId] = chat;
    delete trashed[chatId];
    return clone(chat.meta);
  },

  async searchChats(query: string): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    for (const chat of Object.values(chats)) {
      if (!chat.meta.pinned && hits.length > 20) break;
      const titleHit = chat.meta.title.toLowerCase().includes(needle);
      const contentHit = chat.messages.find((m) => m.content.toLowerCase().includes(needle));
      if (titleHit) {
        hits.push({ chat: clone(chat.meta), snippet: chat.meta.preview });
      } else if (contentHit) {
        const at = contentHit.content.toLowerCase().indexOf(needle);
        const start = Math.max(0, at - 46);
        const snippet =
          (start > 0 ? "…" : "") +
          plain(contentHit.content.slice(start, at + needle.length + 74)) +
          "…";
        hits.push({ chat: clone(chat.meta), snippet });
      }
    }
    return hits;
  },

  async readImage(_chatId: string, attachmentId: string): Promise<string> {
    return previewImages.get(attachmentId) ?? "";
  },

  async stopStream(chatId: string) {
    cancelled.add(chatId);
  },

  async stream(
    command: string,
    args: Record<string, unknown>,
    onEvent: (event: StreamEvent) => void,
  ): Promise<string> {
    let chat: Chat | undefined;
    const chatId = typeof args.chatId === "string" ? args.chatId : null;
    let reply = REPLY;

    if (command === "send_message") {
      const text = String(args.text ?? "").trim();
      const images = Array.isArray(args.images)
        ? (args.images as { dataUrl: string; width: number; height: number }[])
        : [];
      if (!text && images.length === 0) throw "Message is empty";
      chat = chatId ? chats[chatId] : undefined;
      if (!chat) {
        const freshId = id("c");
        chat = {
          meta: {
            id: freshId,
            title: text.slice(0, 60),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            pinned: false,
            messageCount: 0,
            preview: "",
          },
          messages: [],
        };
        chats[freshId] = chat;
      }
      reply = /grid|css|overflow/i.test(text) ? SHORT_REPLY : REPLY;
      const attachments = images.map((image, index) => {
        const attachmentId = id("img");
        previewImages.set(attachmentId, image.dataUrl);
        return {
          id: attachmentId,
          file: `${attachmentId}.png`,
          mime: "image/png",
          width: image.width,
          height: image.height,
          bytes: Math.round((image.dataUrl.length * 3) / 4),
          kind: "user",
          index,
        };
      });
      const userMessage = msg("user", text, Date.now());
      if (attachments.length) userMessage.attachments = attachments;
      chat.messages.push(userMessage);
    } else if (command === "regenerate") {
      if (!chatId) throw "Chat not found";
      chat = chats[chatId];
      if (!chat) throw "Chat not found";
      const lastAssistant = chat.messages.map((m) => m.role).lastIndexOf("assistant");
      if (lastAssistant === -1) throw "Nothing to regenerate yet.";
      chat.messages = chat.messages.slice(0, lastAssistant);
      reply = REPLY;
    } else if (command === "edit_message") {
      if (!chatId) throw "Chat not found";
      chat = chats[chatId];
      if (!chat) throw "Chat not found";
      const messageId = String(args.messageId ?? "");
      const index = chat.messages.findIndex((m) => m.id === messageId);
      if (index === -1) throw "Message not found";
      chat.messages = chat.messages.slice(0, index);
      chat.messages.push(msg("user", String(args.text ?? ""), Date.now()));
      reply = REPLY;
    }

    if (!chat) throw "Chat not found";
    const target = chat;
    const assistant: Message = {
      id: id("m"),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      status: "streaming",
    };
    target.messages.push(assistant);
    target.meta.updatedAt = Date.now();
    rehash(target);
    cancelled.delete(target.meta.id);

    onEvent({ kind: "started", messages: clone(target.messages), meta: clone(target.meta) });

    await sleep(220);

    const lastUser = [...target.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const shouldFail = /\bfail\b|\berror\b|\boffline\b/i.test(lastUser);

    const tokens = reply.match(/\s+|\S+/g) ?? [];
    let buffer = "";
    for (const token of tokens) {
      if (cancelled.has(target.meta.id)) break;
      buffer += token;
      onEvent({ kind: "delta", text: token });
      await sleep(token.trim().length > 6 ? 26 : 14);

      // Design-time failure path: send a message containing "fail" to preview
      // the error state (partial reply + inline error).
      if (shouldFail && buffer.length > 90) {
        assistant.content = buffer;
        assistant.status = "error";
        assistant.error =
          "Could not connect to api.example.com. Check the endpoint in the build config.";
        target.meta.updatedAt = Date.now();
        rehash(target);
        onEvent({
          kind: "error",
          message: assistant.error,
          messages: clone(target.messages),
          meta: clone(target.meta),
        });
        return target.meta.id;
      }
    }

    assistant.content = buffer;
    assistant.status = cancelled.has(target.meta.id) ? "aborted" : "complete";
    target.meta.updatedAt = Date.now();
    rehash(target);
    onEvent({ kind: "done", messages: clone(target.messages), meta: clone(target.meta) });
    return target.meta.id;
  },

  async getSettings(): Promise<SettingsView> {
    return {
      projectsDir: "C:/Users/you/Documents/Hook",
      advancedMode: MOCK_ADVANCED,
      plan: MOCK_PLAN,
      cloudSync: MOCK_CLOUD_SYNC,
      customProvider: MOCK_PROVIDER,
      projects: [
        {
          id: "pj_mock_invoice",
          name: "invoice-parser",
          path: "C:/Users/you/Documents/Hook/invoice-parser",
          description:
            "Python CLI that turns supplier PDFs into line items. pdfplumber plus a sqlite cache.",
          createdAt: Date.now() - 9 * DAY,
          updatedAt: Date.now() - 2 * DAY,
          isGit: true,
        },
        {
          id: "pj_mock_site",
          name: "site",
          path: "C:/Users/you/Documents/Hook/site",
          description: "Personal site: Astro, Tailwind, Cloudflare Pages.",
          createdAt: Date.now() - 30 * DAY,
          updatedAt: Date.now() - 5 * HOUR,
          isGit: true,
        },
      ],
    };
  },

  async setProjectsDir(path: string): Promise<SettingsView> {
    const view = await mock.getSettings();
    return { ...view, projectsDir: path };
  },

  async setAdvancedMode(enabled: boolean): Promise<SettingsView> {
    MOCK_ADVANCED = enabled;
    return mock.getSettings();
  },

  async setCloudSync(enabled: boolean): Promise<SettingsView> {
    if (MOCK_PLAN === "free" && enabled) {
      throw new Error("Cloud sync is part of a paid plan.");
    }
    MOCK_CLOUD_SYNC = enabled;
    return mock.getSettings();
  },

  async setCustomProvider(
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<SettingsView> {
    if (!baseUrl.trim() || !model.trim()) {
      throw new Error("Enter an endpoint and a model name.");
    }
    if (!apiKey.trim() && !MOCK_PROVIDER?.hasKey) {
      throw new Error("Enter the API key for this endpoint.");
    }
    MOCK_PROVIDER = { baseUrl: baseUrl.trim(), model: model.trim(), hasKey: true };
    return mock.getSettings();
  },

  async clearCustomProvider(): Promise<SettingsView> {
    MOCK_PROVIDER = null;
    return mock.getSettings();
  },

  async customModels(baseUrl: string, apiKey: string): Promise<string[]> {
    if (!baseUrl.trim()) throw new Error("Enter the endpoint first.");
    if (!apiKey.trim() && !MOCK_PROVIDER?.hasKey) throw new Error("Enter the API key first.");
    await sleep(300);
    return [
      "gpt-4o",
      "gpt-4o-mini",
      "llama-3.3-70b-instruct",
      "mistral-large-latest",
      "o3-mini",
    ];
  },

  async agentTranscript(agentId: string): Promise<AgentTranscript> {
    // Design-time preview: enough of a run to style the inspector. The real
    // transcript comes from the coding engine's session file.
    return {
      id: agentId,
      title: "Build the launch page",
      project: "site",
      state: "running",
      live: true,
      items: [
        {
          id: "t-user",
          kind: "user",
          text: "Build a launch page for the new release, and check it on a phone before you finish.",
        },
        {
          id: "t-think-1",
          kind: "thinking",
          text: "The site is Astro with Tailwind. I should read the existing layout first so the new page matches the rest of the site instead of inventing a second style.",
        },
        {
          id: "t-read",
          kind: "tool",
          name: "read",
          args: { path: "src/pages/index.astro" },
          output:
            "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title=\"Site\">…",
          status: "done",
        },
        { id: "t-text-1", kind: "text", text: "Let me look at how the current page is put together." },
        {
          id: "t-write",
          kind: "tool",
          name: "write",
          args: {
            path: "src/pages/launch.astro",
            content: "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout title=\"Launch\">…",
          },
          output: "Wrote 42 lines to src/pages/launch.astro",
          status: "done",
        },
        {
          id: "t-bash",
          kind: "tool",
          name: "bash",
          args: { command: "pnpm build", timeout: 120 },
          output: "vite v5.4.2 building for production…\n✓ 41 modules transformed.\n✓ built in 3.18s",
          status: "done",
        },
        {
          id: "t-think-2",
          kind: "thinking",
          text: "The build passes. Next I want a narrow screenshot at 390px to be sure the headline and the cards stack without clipping.",
        },
        {
          id: "t-shot",
          kind: "tool",
          name: "bash",
          args: { command: "edge --headless --screenshot=launch-mobile.png --window-size=390,844 http://localhost:4321/launch" },
          status: "running",
        },
        { id: "t-note", kind: "text", text: "The page is built; I am checking the phone layout now." },
        { id: "t-now", kind: "thinking", text: "The headline wraps to three lines at 390px — I will tighten the type scale." },
      ] satisfies AgentTranscript["items"],
      truncated: false,
    };
  },

  async agentsOverview(): Promise<AgentsOverview> {
    // Design-time preview: `?agents=1` puts a working agent (with a checklist)
    // in the first chat, so the task board can be styled without the desktop
    // shell. `?agents=needs_input` previews the waiting state and
    // `?agents=done` the finished one.
    const demo = new URLSearchParams(window.location.search).get("agents");
    if (!demo) return { working: 0, live: 0, agents: [] };
    const now = Date.now();
    const waiting = demo === "needs_input";
    const finished = demo === "done";
    const startedAt = now - (finished ? 214_000 : 96_000);
    // The finished demo settles a little before "now", like a real run does.
    const settledAt = now - 41_000;
    const step = (
      title: string,
      status: PlanStep["status"],
      from: number,
      to?: number,
    ): PlanStep => ({
      title,
      status,
      startedAt: status === "pending" ? undefined : startedAt + from,
      finishedAt: status === "done" && to !== undefined ? startedAt + to : undefined,
    });
    const plan: PlanStep[] = [
      step("Setting things up", "done", 0, 18_000),
      step("Designing the launch page", "done", 18_000, 74_000),
      step(
        "Connecting it to the real services",
        finished ? "done" : "active",
        74_000,
        finished ? 138_000 : undefined,
      ),
      step(
        "Checking it on a phone",
        finished ? "done" : "pending",
        138_000,
        finished ? settledAt - startedAt - 12_000 : undefined,
      ),
      step(
        "Polishing the details",
        finished ? "done" : "pending",
        settledAt - startedAt - 12_000,
        finished ? settledAt - startedAt : undefined,
      ),
    ];
    return {
      working: finished || waiting ? 0 : 1,
      live: finished ? 0 : 1,
      agents: [
        {
          id: "ag_demo",
          chatId: "c8",
          title: "Build the launch page",
          project: "site",
          state: finished ? "idle" : waiting ? "needs_input" : "running",
          steps: 18,
          createdAt: now - (finished ? 214_000 : 96_000),
          updatedAt: now,
          finishedAt: finished ? now - 41_000 : undefined,
          waiting,
          direct: false,
          plan,
        },
      ],
    };
  },

  async stopChatAgents(): Promise<AgentsOverview> {
    return { working: 0, live: 0, agents: [] };
  },

  /** Browser preview: a coding chat is an ordinary empty chat with the marker. */
  async createCodingChat(folder: string): Promise<ChatMeta> {
    const now = Date.now();
    const chatId = id("coding");
    const name =
      folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Coding agent";
    const chat: Chat = {
      meta: {
        id: chatId,
        title: name,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        messageCount: 0,
        preview: "",
        kind: "coding",
        projectPath: folder,
      },
      messages: [],
    };
    chats[chatId] = chat;
    return clone(chat.meta);
  },

  async setCodingChatFolder(chatId: string, folder: string): Promise<ChatMeta> {
    const chat = chats[chatId];
    if (!chat) throw "Chat not found";
    chat.meta.projectPath = folder;
    chat.meta.sessionId = undefined;
    return clone(chat.meta);
  },

  async createRemoteCodingChat(
    deviceId: string,
    project: string,
  ): Promise<ChatMeta> {
    const device = MOCK_DEVICES.find((entry) => entry.id === deviceId);
    if (!device) throw "That machine is no longer on this account.";
    if (!device.hostOnline) throw `${device.name} is not online.`;
    const now = Date.now();
    const chatId = id("coding");
    const meta: ChatMeta = {
      id: chatId,
      title: project,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      messageCount: 0,
      preview: "",
      kind: "coding",
      deviceId,
      deviceName: device.name,
      remote: true,
      stubState: "idle",
    };
    chats[chatId] = { meta, messages: [] };
    return clone(meta);
  },

  async fetchRemoteChat(chatId: string): Promise<Chat> {
    const chat = chats[chatId];
    if (!chat) throw "Chat not found";
    if (!chat.meta.remote) return clone(chat);
    if (!chat.messages.length) {
      const now = Date.now();
      chat.messages = [
        {
          id: id("m"),
          role: "assistant",
          content:
            "I am on the other machine, in that project. This is a cached copy of the conversation; the engine and the folder stay there.",
          createdAt: now,
          status: "complete",
        },
      ];
      chat.meta.updatedAt = now;
      chat.meta.messageCount = 1;
    }
    return clone(chat);
  },

  async remoteProjects(_deviceId: string): Promise<RemoteProject[]> {
    return clone(MOCK_REMOTE_PROJECTS);
  },

  async createRemoteProject(
    _deviceId: string,
    name: string,
    description: string,
  ): Promise<RemoteProject> {
    const clean = name.trim();
    if (!clean) throw new Error("Write a project name first.");
    if (MOCK_REMOTE_PROJECTS.some((entry) => entry.project === clean)) {
      throw new Error(`A project named "${clean}" already exists.`);
    }
    const project: RemoteProject = {
      project: clean,
      description: description.trim(),
      git: false,
    };
    MOCK_REMOTE_PROJECTS.push(project);
    return clone(project);
  },

  async answerCodingAgent(): Promise<void> {
    // Nothing is waiting in the browser preview.
  },

  async memoryList(): Promise<MemoryView> {
    return memoryView();
  },

  async memorySave(text: string, pinned: boolean): Promise<MemoryView> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Write what to remember first.");
    MOCK_MEMORY.unshift({
      id: `mem-${Math.random().toString(36).slice(2, 10)}`,
      text: trimmed,
      kind: "user",
      pinned,
      chatId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      age: "just now",
    });
    return memoryView();
  },

  async memoryUpdate(
    id: string,
    text: string | null,
    pinned: boolean | null,
  ): Promise<MemoryView> {
    const entry = MOCK_MEMORY.find((item) => item.id === id);
    if (!entry) throw new Error("That memory no longer exists.");
    if (text !== null) entry.text = text.trim() || entry.text;
    if (pinned !== null) entry.pinned = pinned;
    entry.updatedAt = Date.now();
    entry.age = "just now";
    return memoryView();
  },

  async memoryDelete(id: string): Promise<MemoryView> {
    const index = MOCK_MEMORY.findIndex((item) => item.id === id);
    if (index >= 0) MOCK_MEMORY.splice(index, 1);
    return memoryView();
  },

  async memoryClear(): Promise<MemoryView> {
    MOCK_MEMORY.length = 0;
    return memoryView();
  },

  async memorySetEnabled(enabled: boolean): Promise<MemoryView> {
    MOCK_MEMORY_ENABLED = enabled;
    return memoryView();
  },

  async devices(): Promise<DevicesView> {
    return {
      state: "online",
      message: null,
      error: null,
      selfId: MOCK_SELF_DEVICE,
      selfName: "This computer",
      devices: clone(MOCK_DEVICES),
    };
  },

  async renameDevice(deviceId: string, name: string): Promise<DeviceView> {
    const device = MOCK_DEVICES.find((entry) => entry.id === deviceId);
    if (!device) throw "That machine is no longer on this account.";
    device.name = name.trim().slice(0, 60) || device.name;
    return clone(device);
  },

  async setDeviceRemote(deviceId: string, allowed: boolean): Promise<DeviceView> {
    const device = MOCK_DEVICES.find((entry) => entry.id === deviceId);
    if (!device) throw "That machine is no longer on this account.";
    device.remoteAllowed = allowed;
    return clone(device);
  },

  async removeDevice(deviceId: string): Promise<void> {
    const at = MOCK_DEVICES.findIndex((entry) => entry.id === deviceId);
    if (at >= 0) MOCK_DEVICES.splice(at, 1);
  },

  async syncStatus(): Promise<SyncView> {
    const available = MOCK_PLAN !== "free";
    const enabled = available && MOCK_CLOUD_SYNC;
    return {
      enabled,
      available,
      reason: !available ? "free" : !MOCK_CLOUD_SYNC ? "off" : null,
      state: enabled ? "idle" : "off",
      cursor: enabled ? 128 : 0,
      pending: 0,
      lastSyncAt: enabled ? Date.now() : 0,
      message: null,
    };
  },

  async syncNow(): Promise<void> {},

  /**
   * Design-time preview: the browser has no file system, so the same import card
   * shows a plausible answer instead of a native picker.
   */
  async importScan(path: string): Promise<ImportPreview> {
    const source = path.toLowerCase().includes("claude") ? "claude" : "chatgpt";
    return {
      source,
      vendor: source === "claude" ? "Claude" : "ChatGPT",
      file: path,
      conversations: 412,
      new: 380,
      updated: 24,
      unchanged: 8,
      keptLocal: 0,
      messages: 3184,
      warnings: [],
    };
  },

  async importApply(path: string): Promise<ImportSummary> {
    const source = path.toLowerCase().includes("claude") ? "claude" : "chatgpt";
    return {
      source,
      vendor: source === "claude" ? "Claude" : "ChatGPT",
      imported: 380,
      updated: 24,
      unchanged: 8,
      keptLocal: 0,
      messages: 3184,
      chatIds: [],
      warnings: [],
    };
  },

  async previewState(): Promise<PreviewView | null> {
    // Design-time preview: `?preview=1` opens the panel with a sample page,
    // `?preview=waiting` shows the state before the coding agent writes it,
    // `?preview=done` shows the panel after the run settled, and
    // `?preview=board|task|document` shows a Hook Workspace entity.
    const demo = new URLSearchParams(window.location.search).get("preview");
    if (!demo) return null;
    if (demo === "board") {
      return {
        active: true,
        chatId: "c8",
        kind: "board",
        board: DEMO_BOARD,
        tasks: DEMO_TASKS,
        title: DEMO_BOARD.name,
        version: 1,
        open: true,
        waiting: false,
        live: false,
      };
    }
    if (demo === "task") {
      return {
        active: true,
        chatId: "c8",
        kind: "task",
        task: DEMO_TASKS[0],
        comments: [
          {
            id: "comment_1",
            author: "Mallory",
            authorKind: "user",
            body: "Can we ship this on the 14th?",
            createdAt: Date.now() - 3_600_000,
          },
          {
            id: "comment_2",
            author: "Hook",
            authorKind: "agent",
            viaChatId: "c8",
            body: "Moved it to *In progress* and left a note on the page.",
            createdAt: Date.now() - 1_800_000,
          },
        ],
        title: DEMO_TASKS[0].title,
        version: 1,
        open: true,
        waiting: false,
        live: false,
      };
    }
    if (demo === "document") {
      return {
        active: true,
        chatId: "c8",
        kind: "document",
        document: {
          id: "doc_1",
          projectId: "prj_demo",
          title: "Release checklist",
          markdown:
            "# Release checklist\n\n- [x] Pricing page\n- [ ] Release notes\n- [ ] Invoice totals\n\n> Ask Mallory about the 14th.",
          rev: 3,
          updatedAt: Date.now(),
        },
        title: "Release checklist",
        version: 1,
        open: true,
        waiting: false,
        live: false,
      };
    }
    const waiting = demo === "waiting";
    const live = demo !== "done";
    return {
      active: true,
      chatId: "c8",
      project: "site",
      file: "dist/index.html",
      title: "Launch page",
      url: waiting ? undefined : PREVIEW_URL,
      version: 1,
      open: true,
      waiting,
      live,
    };
  },

};
