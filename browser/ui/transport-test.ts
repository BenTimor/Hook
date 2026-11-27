/**
 * A regression check for the dock's live text, without a browser backend, a model
 * or a Chromium build.
 *
 * The bug it exists for: a poll that found the turn over emitted `delta` as well
 * as `done`. The dock coalesces deltas into an animation frame, so that delta
 * flushed *after* `done` had replaced the thread with the store's copy, and
 * re-appended text that was already on screen — a reply drawn twice, which the
 * next message "fixed" by replacing the list again.
 *
 * It replays the same order against `channelTransport` with a fake handler, feeds
 * the events through the dock's own reducer rules (append deltas to the last
 * message on the next frame, replace on `started`/`done`), and checks the thread
 * ends with the reply exactly once.
 *
 *   pnpm browser:ui:dev → http://localhost:5173/transport-test.html
 *
 * Vite serves it as a page; nothing imports it, so it is not in `panel.mjs`.
 */
import type { DockMessage } from "@hook/chat";

import type { ChatMessage, ChatSummary, ChatView, HookPageHandler, Tab } from "./mojom";
import { channelTransport } from "./transport";

const REPLY = "Two copies of one greeting is one too many.";

const summary = (busy: boolean): ChatSummary => ({
  id: "c1",
  title: "Test",
  updatedAt: 1,
  busy,
  unsynced: false,
});

const message = (id: string, role: string, content: string, status: string): ChatMessage => ({
  id,
  role,
  content,
  status,
  hidden: false,
  error: "",
  reasoning: "",
  toolCalls: [],
  toolCallId: "",
});

const tab: Tab = { index: 0, id: 1, active: true, title: "Hook", domain: "hook" };

/** A handler that answers in the order that used to duplicate the reply. */
function fakeHandler(): HookPageHandler {
  let reads = 0;
  return {
    getTabs: async () => ({ tabs: [tab] }),
    showUI: () => {},
    getChannel: async () => ({ available: true, reason: "" }),
    getSettings: async () => ({ advancedMode: false }),
    listChats: async () => ({ chats: [summary(false)], error: "" }),
    createChat: async () => ({ id: "c1", error: "" }),
    sendMessage: async () => ({ ok: true, error: "" }),
    stopMessage: () => {},
    getChat: async (): Promise<{ chat: ChatView | null; error: string }> => {
      reads += 1;
      // 1: right after the send — the turn has not written the reply yet.
      // 2: the reply appears (it must not be glued onto the user's message).
      // 3: one more chunk, still busy.
      // 4: the last chunk and the end of the turn in the same read, which is the
      //    case that used to draw the text twice.
      const busy = reads < 4;
      const messages: ChatMessage[] = [message("u1", "user", "hello", "complete")];
      if (reads >= 2) {
        const text = reads >= 4 ? `${REPLY} And a tail.` : REPLY;
        messages.push(message("a1", "assistant", text, busy ? "streaming" : "complete"));
      }
      return { chat: { chat: summary(busy), messages }, error: "" };
    },
  };
}

/** The dock's rules: deltas append to the last message on the next frame. */
class DockSim {
  messages: DockMessage[] = [];
  private pending = "";
  private frame: ReturnType<typeof setTimeout> | null = null;

  apply(event: { kind: string; text?: string; messages?: DockMessage[] }) {
    if (event.kind === "started" || event.kind === "done") {
      if (event.messages) this.messages = event.messages.map((entry) => ({ ...entry }));
      return;
    }
    if (event.kind === "delta") {
      this.pending += event.text ?? "";
      if (this.frame === null) {
        this.frame = setTimeout(() => {
          this.frame = null;
          const text = this.pending;
          this.pending = "";
          if (!text || this.messages.length === 0) return;
          const last = this.messages[this.messages.length - 1];
          this.messages = [
            ...this.messages.slice(0, -1),
            { ...last, content: last.content + text },
          ];
        }, 16);
      }
    }
  }

  /** Let queued frames run, so a late delta would show up. */
  async settle(): Promise<void> {
    await new Promise((done) => setTimeout(done, 120));
  }
}

export interface TransportTestResult {
  ok: boolean;
  failures: string[];
  events: string[];
  thread: { role: string; content: string }[];
}

export async function runTransportTest(): Promise<TransportTestResult> {
  const events: string[] = [];
  const dock = new DockSim();
  const transport = channelTransport(fakeHandler());
  const unsubscribe = transport.subscribe((_chatId, event) => {
    events.push(`${event.kind}${event.text ? `:${event.text.length}` : ""}`);
    dock.apply(event);
  });

  await transport.send(null, "hello");
  // Four polls at POLL_MS (350 ms each), plus a frame.
  await new Promise((done) => setTimeout(done, 1800));
  await dock.settle();
  unsubscribe();

  const failures: string[] = [];
  const done = events.indexOf("done");
  if (done === -1) failures.push("no done event");
  if (done !== -1 && events.slice(done + 1).some((event) => event.startsWith("delta"))) {
    failures.push("a delta was emitted after done");
  }
  const answer = [...dock.messages].reverse().find((entry) => entry.role === "assistant");
  if (!answer) {
    failures.push("no assistant message");
  } else if (answer.content !== `${REPLY} And a tail.`) {
    failures.push(`the reply is "${answer.content}"`);
  }
  const asked = dock.messages.find((entry) => entry.role === "user");
  if (asked?.content !== "hello") {
    failures.push(`the user's message became "${asked?.content ?? ""}"`);
  }
  const started = events.indexOf("started");
  if (started === -1) failures.push("no started event");

  return {
    ok: failures.length === 0,
    failures,
    events,
    thread: dock.messages.map((entry) => ({ role: entry.role, content: entry.content })),
  };
}
