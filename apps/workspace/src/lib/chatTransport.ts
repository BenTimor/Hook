import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@hook/ui";
import type {
  ChatTransport,
  DockChat,
  DockEvent,
  DockMessage,
  DockReport,
} from "@hook/chat";

interface ChatMeta {
  id: string;
  title: string;
  updatedAt: number;
  /** "coding" for a conversation the user has with a coding agent directly. */
  kind?: string;
}

interface Chat {
  meta: ChatMeta;
  messages: DockMessage[];
}

/**
 * The chat behind the dock.
 *
 * These are the same backend commands the chat app calls: the chats are the
 * same objects (synced through the account), so a conversation started here
 * shows up in Hook a few seconds later, and the other way round.
 */
export const chatTransport: ChatTransport = {
  async listChats(): Promise<DockChat[]> {
    if (!isTauri()) return demoList;
    const chats = await invoke<ChatMeta[]>("list_chats");
    // The dock is the chat agent's quick panel. A conversation with a coding
    // agent belongs to the folder and the engine on this computer, and it is
    // part of the chat window's advanced view, not this one.
    return chats
      .filter((chat) => chat.kind !== "coding")
      .map((chat) => ({
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt,
      }));
  },

  async getChat(id: string): Promise<{ messages: DockMessage[] }> {
    if (!isTauri()) return { messages: demoMessages.get(id) ?? [] };
    const chat = await invoke<Chat>("get_chat", { chatId: id });
    return { messages: chat.messages };
  },

  async searchChats(query: string): Promise<DockChat[]> {
    if (!isTauri()) {
      const needle = query.trim().toLowerCase();
      return demoList.filter((chat) => chat.title.toLowerCase().includes(needle));
    }
    const hits = await invoke<Array<{ chat: { id: string; title: string; updatedAt: number; kind?: string } }>>(
      "search_chats",
      { query },
    );
    return hits
      .filter((hit) => hit.chat.kind !== "coding")
      .map((hit) => ({
        id: hit.chat.id,
        title: hit.chat.title,
        updatedAt: hit.chat.updatedAt,
      }));
  },

  async send(chatId: string | null, text: string): Promise<string> {
    if (!isTauri()) return demoReply(chatId, text);
    return invoke<string>("send_message", { chatId, text });
  },

  async stop(chatId: string): Promise<void> {
    if (!isTauri()) return;
    await invoke("stop_stream", { chatId });
  },

  async report(input: DockReport): Promise<void> {
    if (!isTauri()) {
      // Nothing to review in a browser preview, but the flow must be clickable.
      console.info("[preview] report", input.messageId, input.reason);
      return;
    }
    await invoke("report_message", {
      payload: {
        chatId: input.chatId,
        messageId: input.messageId,
        reason: input.reason,
        note: input.note,
        content: input.content,
        transcript: input.transcript,
      },
    });
  },

  subscribe(listener: (chatId: string, event: DockEvent) => void): () => void {
    if (!isTauri()) {
      demoListeners.add(listener);
      return () => demoListeners.delete(listener);
    }
    const pending = listen<{ chatId: string; event: DockEvent }>("hook://chat", (event) =>
      listener(event.payload.chatId, event.payload.event),
    );
    return () => {
      void pending.then((off) => off()).catch(() => {});
    };
  },
};

// A browser preview has no Rust behind it, so the dock answers with a canned
// reply. It is the same event shape the backend sends, so the panel is being
// exercised properly rather than faked at the last moment.
const demoListeners = new Set<(chatId: string, event: DockEvent) => void>();
const demoMessages = new Map<string, DockMessage[]>();
let demoSeq = 0;

// Two conversations so the browser preview has a history worth opening.
const demoList: DockChat[] = [
  { id: "chat-demo-a", title: "Plan the Hook Roadmap board", updatedAt: Date.now() - 40 * 60_000 },
  { id: "chat-demo-b", title: "Summarise the brand brief", updatedAt: Date.now() - 26 * 3_600_000 },
];
demoMessages.set("chat-demo-a", [
  { id: "a1", role: "user", content: "Plan the Hook Roadmap board" },
  {
    id: "a2",
    role: "assistant",
    content:
      "A first pass: **To do** holds the browser and affiliate work, **In progress** holds ads, and design sits in review.",
  },
]);

function demoEmit(chatId: string, event: DockEvent): void {
  for (const listener of demoListeners) listener(chatId, event);
}

function demoReply(chatId: string | null, text: string): string {
  const id = chatId ?? `chat-demo-${(demoSeq += 1)}`;
  const history = demoMessages.get(id) ?? [];
  const user: DockMessage = {
    id: `m${(demoSeq += 1)}`,
    role: "user",
    content: text,
  };
  const reply: DockMessage = {
    id: `m${(demoSeq += 1)}`,
    role: "assistant",
    content: "",
    status: "streaming",
  };
  const next = [...history, user, reply];
  demoMessages.set(id, next);
  if (!demoList.some((chat) => chat.id === id)) {
    demoList.unshift({
      id,
      title: text.slice(0, 40) || "New chat",
      updatedAt: Date.now(),
    });
  }
  demoEmit(id, { kind: "started", messages: next.map((message) => ({ ...message })) });

  const words = "This is the browser preview — the real answer comes from Hook.".split(" ");
  words.forEach((word, index) => {
    setTimeout(
      () => demoEmit(id, { kind: "delta", text: index === 0 ? word : ` ${word}` }),
      120 + index * 40,
    );
  });
  setTimeout(() => {
    const done: DockMessage = { ...reply, content: words.join(" "), status: "done" };
    const settled = [...next];
    settled[settled.length - 1] = done;
    demoMessages.set(id, settled);
    demoEmit(id, { kind: "done", messages: settled });
    demoEmit(id, { kind: "activity", label: null });
  }, 160 + words.length * 40);
  return id;
}

/**
 * Tell the backend what the window is showing. It rides on the next chat
 * request as context, so "summarise this board" means the board on screen.
 */
export async function setChatContext(context: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("set_chat_context", { context });
  } catch {
    // Context is an enhancement; a failure must never interrupt typing.
  }
}
