/**
 * The dock's two transports.
 *
 * `channelTransport` is the real one: it asks the browser process, over mojom, for
 * the conversations a **running** Hook app has (`hooks-core`'s `channel.rs`), and
 * sends into them. The turn is the app's own, so an answer written here is in the
 * window a second later, and the other way round.
 *
 * `localTransport` is what is left when there is no app: a self-contained
 * conversation, so the surface can still be looked at and demonstrated. It never
 * pretends to be a model — it says so in its own reply.
 *
 * Streaming is polling here on purpose: the channel returns `busy` on the chat
 * while a turn runs, and one poll per ~350 ms is enough for the typing to read as
 * live without inventing a second streaming protocol. The sidecar in
 * `docs/browser-poc-plan.md` can stream over mojom when it exists; the dock does
 * not care, because the events it receives are the same.
 */
import type { ChatTransport, DockChat, DockEvent, DockMessage } from "@hook/chat";

import { activeTab, type ChatMessage, type ChatSummary, type HookPageHandler } from "./mojom";

const POLL_MS = 350;

function toMessage(message: ChatMessage): DockMessage {
  return {
    id: message.id,
    role: message.role as DockMessage["role"],
    content: message.content,
    status: message.status,
    hidden: message.hidden,
    error: message.error || null,
  };
}

function toChat(summary: ChatSummary): DockChat {
  return {
    id: summary.id,
    title: summary.title,
    updatedAt: summary.updatedAt,
    unsynced: summary.unsynced,
  };
}

/** The trailing context frame: which page the user is asking about. */
async function tabContext(handler: HookPageHandler): Promise<string> {
  const { tabs } = await handler.getTabs();
  const tab = activeTab(tabs);
  if (!tab) return "Browser: Hook Browser";
  return [
    "Browser: Hook Browser",
    `Tab: ${tab.index + 1} of ${tabs.length} (id: ${tab.id})`,
    `Title: ${tab.title}`,
    `Domain: ${tab.domain}`,
  ].join("\n");
}

export function channelTransport(handler: HookPageHandler): ChatTransport {
  const listeners = new Set<(chatId: string, event: DockEvent) => void>();
  const watches = new Map<string, () => void>();

  const emit = (chatId: string, event: DockEvent) => {
    for (const listener of listeners) listener(chatId, event);
  };

  const lastAnswer = (messages: DockMessage[]): DockMessage | undefined =>
    [...messages].reverse().find((message) => message.role === "assistant");

  /**
   * Poll one chat while its turn runs, and emit the text as it grows.
   *
   * `alreadyDrawn` is how much of the reply the dock has: the `started` snapshot,
   * or the transcript it just opened. A delta therefore only ever carries text
   * that is not on screen yet.
   *
   * A poll that finds the turn over emits `done` **instead of** a delta, never as
   * well: the dock coalesces deltas into an animation frame, so a delta queued in
   * the same tick as `done` flushes *after* the authoritative list replaced the
   * screen and re-appends text that is already there — the reply drawn twice,
   * which is exactly the bug this replaced.
   */
  const watch = (chatId: string, drawnId: string | null, alreadyDrawn: number) => {
    if (watches.has(chatId)) return;
    let answerId = drawnId;
    let shown = alreadyDrawn;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stopWatch = () => {
      if (timer) clearInterval(timer);
      timer = null;
      watches.delete(chatId);
    };

    timer = setInterval(async () => {
      try {
        const { chat, error } = await handler.getChat(chatId);
        if (error || !chat) {
          emit(chatId, { kind: "error", message: error || "The conversation went away." });
          stopWatch();
          return;
        }
        const messages = chat.messages.map(toMessage);
        if (!chat.chat.busy) {
          emit(chatId, { kind: "done", messages });
          stopWatch();
          return;
        }
        const answer = lastAnswer(messages);
        if (!answer) return;
        if (answer.id !== answerId) {
          // The reply is drawn for the first time (the send's snapshot was taken
          // before the turn wrote it), or the thread was replaced: show the
          // store's list whole. A delta may only ever append to the reply itself,
          // never to whatever the dock happens to have last — that would glue
          // the answer onto the user's message.
          emit(chatId, { kind: "started", messages });
          answerId = answer.id;
          shown = answer.content.length;
          return;
        }
        if (answer.content.length > shown) {
          emit(chatId, { kind: "delta", text: answer.content.slice(shown) });
          shown = answer.content.length;
        }
      } catch (failure) {
        emit(chatId, { kind: "error", message: String(failure) });
        stopWatch();
      }
    }, POLL_MS);
    watches.set(chatId, stopWatch);
  };

  return {
    async listChats(): Promise<DockChat[]> {
      const { chats, error } = await handler.listChats();
      if (error) throw new Error(error);
      return chats.map(toChat);
    },

    async getChat(id: string): Promise<{ messages: DockMessage[] }> {
      const { chat, error } = await handler.getChat(id);
      if (error) throw new Error(error);
      const messages = (chat?.messages ?? []).map(toMessage);
      // Reopened while its turn is still running: follow it, seeded with what the
      // thread is about to draw.
      if (chat?.chat.busy) {
        const answer = lastAnswer(messages);
        watch(id, answer?.id ?? null, (answer?.content ?? "").length);
      }
      return { messages };
    },

    async send(chatId: string | null, text: string): Promise<string> {
      let id = chatId;
      if (!id) {
        const created = await handler.createChat();
        if (created.error) throw new Error(created.error);
        id = created.id;
      }
      const sent = await handler.sendMessage(id, text, await tabContext(handler));
      if (!sent.ok) throw new Error(sent.error);
      const view = await handler.getChat(id);
      let drawnId: string | null = null;
      let drawn = 0;
      if (view.chat) {
        const messages = view.chat.messages.map(toMessage);
        emit(id, { kind: "started", messages });
        const answer = lastAnswer(messages);
        drawnId = answer?.id ?? null;
        drawn = (answer?.content ?? "").length;
      }
      watch(id, drawnId, drawn);
      return id;
    },

    async stop(chatId: string): Promise<void> {
      handler.stopMessage(chatId);
      watches.get(chatId)?.();
    },

    subscribe(listener: (chatId: string, event: DockEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The self-contained conversation: no app, no model, no network.
 *
 * It exists so `chrome://hook` and `pnpm browser:ui:dev` can be looked at before
 * Hook is running, and it says what it is instead of inventing an answer.
 */
export function localTransport(why: string): ChatTransport {
  const listeners = new Set<(chatId: string, event: DockEvent) => void>();
  let conversation: DockChat | null = null;
  let messages: DockMessage[] = [];
  let nextId = 1;

  const emit = (chatId: string, event: DockEvent) => {
    for (const listener of listeners) listener(chatId, event);
  };

  const answerFor = (text: string): string =>
    [
      why,
      "",
      `You said: “${text}”`,
      "",
      "This reply is drawn locally: start Hook on this computer and the panel",
      "talks to your real conversations instead.",
    ].join("\n");

  return {
    async listChats(): Promise<DockChat[]> {
      return conversation ? [conversation] : [];
    },

    async getChat(): Promise<{ messages: DockMessage[] }> {
      return { messages: [...messages] };
    },

    async send(chatId: string | null, text: string): Promise<string> {
      const id = chatId ?? "local";
      if (!conversation || conversation.id !== id) {
        conversation = { id, title: text.slice(0, 48) || "Hook", updatedAt: Date.now() };
        messages = [];
      }
      messages = [...messages, { id: `m${nextId++}`, role: "user", content: text }];
      emit(id, { kind: "started", messages: [...messages] });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const reply = answerFor(text);
      const answer: DockMessage = { id: `m${nextId++}`, role: "assistant", content: "" };
      messages = [...messages, answer];
      for (const chunk of reply.match(/[^\n]*\n?/g) ?? []) {
        if (!chunk) continue;
        await new Promise((resolve) => setTimeout(resolve, 12));
        answer.content += chunk;
        messages = [...messages.slice(0, -1), { ...answer }];
        emit(id, { kind: "delta", text: chunk });
      }
      conversation = { ...conversation, updatedAt: Date.now() };
      emit(id, { kind: "done", messages: [...messages] });
      return id;
    },

    async stop(): Promise<void> {},

    subscribe(listener: (chatId: string, event: DockEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
