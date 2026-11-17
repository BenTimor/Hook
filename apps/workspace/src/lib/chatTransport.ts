import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@hook/ui";
import type { ChatTransport, DockChat, DockEvent, DockMessage } from "@hook/chat";

interface ChatMeta {
  id: string;
  title: string;
  updatedAt: number;
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
    return chats.map((chat) => ({
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

  async send(chatId: string | null, text: string): Promise<string> {
    if (!isTauri()) return demoReply(chatId, text);
    return invoke<string>("send_message", { chatId, text });
  },

  async stop(chatId: string): Promise<void> {
    if (!isTauri()) return;
    await invoke("stop_stream", { chatId });
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
const demoList: DockChat[] = [];
let demoSeq = 0;

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
