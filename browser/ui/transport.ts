/**
 * The dock's transport inside the browser, for the POC.
 *
 * `ChatTransport` is the contract `packages/chat` draws against, so the panel in
 * `chrome://hook` is the same component the two desktop apps embed. There is no
 * channel to `hook-core` yet — the sidecar is Step 3 of docs/browser-poc-plan.md
 * — so this transport keeps the conversation in the page and answers locally.
 *
 * When the sidecar lands, this file is the only thing that changes: the methods
 * become calls over the loopback bridge, and the dock does not notice.
 */
import type { ChatTransport, DockChat, DockEvent, DockMessage } from "@hook/chat";

const listeners = new Set<(chatId: string, event: DockEvent) => void>();

/** The one conversation this stub keeps, created on the first send. */
let conversation: DockChat | null = null;
let messages: DockMessage[] = [];
let nextId = 1;

function emit(chatId: string, event: DockEvent): void {
  for (const listener of listeners) {
    listener(chatId, event);
  }
}

/** The reply the panel gives itself until Step 3 wires the real turn. */
function answerFor(text: string): string {
  return [
    "The dock is live: this panel is `ChatDock` from `packages/chat`, drawn from",
    "our own `hook_resources.pak` inside the Chromium we just built, at the same",
    "380px the chat window's dock uses.",
    "",
    `You said: “${text}”`,
    "",
    "The turn itself is local. There is no channel to Hook's backend in the",
    "browser yet — that is Step 3 (`docs/browser-poc-plan.md`), and the transport",
    "in `browser/ui/transport.ts` is the only file that has to change for it.",
  ].join("\n");
}

export const panelTransport: ChatTransport = {
  async listChats(): Promise<DockChat[]> {
    return conversation ? [conversation] : [];
  },

  async getChat(): Promise<{ messages: DockMessage[] }> {
    return { messages: [...messages] };
  },

  async send(chatId: string | null, text: string): Promise<string> {
    const id = chatId ?? "seam-panel";
    if (!conversation || conversation.id !== id) {
      conversation = {
        id,
        title: text.slice(0, 48) || "Hook Browser",
        updatedAt: Date.now(),
      };
      messages = [];
    }

    const user: DockMessage = {
      id: `m${nextId++}`,
      role: "user",
      content: text,
    };
    messages = [...messages, user];
    emit(id, { kind: "started", messages: [...messages] });

    // A couple of frames of pacing, so the activity line and the streaming
    // reply are exercised the way a real turn exercises them.
    await new Promise((resolve) => setTimeout(resolve, 250));
    emit(id, { kind: "activity", label: "Reading the seam" });

    const reply = answerFor(text);
    const assistant: DockMessage = {
      id: `m${nextId++}`,
      role: "assistant",
      content: "",
    };
    messages = [...messages, assistant];
    for (const chunk of reply.match(/[^\n]*\n?/g) ?? []) {
      if (!chunk) continue;
      await new Promise((resolve) => setTimeout(resolve, 18));
      assistant.content += chunk;
      messages = [...messages.slice(0, -1), { ...assistant }];
      emit(id, { kind: "delta", text: chunk });
    }

    conversation = { ...conversation, updatedAt: Date.now() };
    emit(id, { kind: "activity", label: null });
    emit(id, { kind: "done", messages: [...messages] });
    return id;
  },

  async stop(): Promise<void> {
    // Nothing to cancel: the local reply is a timer, and it ends on its own.
  },

  subscribe(listener: (chatId: string, event: DockEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
