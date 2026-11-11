/**
 * In-memory backend used when the UI runs in a plain browser (`pnpm dev`).
 * It lets the interface be designed and reviewed without the Tauri shell, and
 * gives the real app a graceful no-runtime fallback.
 */
import type {
  AgentsOverview,
  AppInfo,
  Chat,
  ChatMeta,
  Message,
  PlanStep,
  SearchHit,
  SettingsView,
  StreamEvent,
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
const info: AppInfo = { version: "0.1.0" };

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

export const mock = {
  async appInfo() {
    return clone(info);
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
      projects: [
        {
          name: "invoice-parser",
          path: "C:/Users/you/Documents/Hook/invoice-parser",
          description:
            "Python CLI that turns supplier PDFs into line items. pdfplumber plus a sqlite cache.",
          createdAt: Date.now() - 9 * DAY,
          updatedAt: Date.now() - 2 * DAY,
          isGit: true,
        },
        {
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
    const plan: PlanStep[] = [
      { title: "Setting things up", status: "done" },
      { title: "Designing the pricing page", status: "done" },
      { title: "Connecting it to the real services", status: finished ? "done" : "active" },
      { title: "Checking it on a phone", status: finished ? "done" : "pending" },
      { title: "Polishing the details", status: finished ? "done" : "pending" },
    ];
    return {
      working: finished || waiting ? 0 : 1,
      live: finished ? 0 : 1,
      agents: [
        {
          id: "ag_demo",
          chatId: "c1",
          title: "Build the pricing page",
          project: "site",
          state: finished ? "idle" : waiting ? "needs_input" : "running",
          steps: 18,
          createdAt: now - (finished ? 214_000 : 96_000),
          updatedAt: now,
          finishedAt: finished ? now - 41_000 : undefined,
          waiting,
          plan,
        },
      ],
    };
  },

  async stopChatAgents(): Promise<AgentsOverview> {
    return { working: 0, live: 0, agents: [] };
  },
};
