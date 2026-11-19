import { useCallback, useEffect, useRef, useState } from "react";
import { List, Search, SquarePen, X } from "lucide-react";
import { HookMark } from "@hook/ui";

import { Composer } from "./Composer";
import { greeting } from "./greeting";
import { ReportDialog } from "./ReportDialog";
import { Thread } from "./Thread";
import type { ChatMessage } from "./types";
import "./dock.css";

export interface DockChat {
  id: string;
  title: string;
  updatedAt: number;
}

export interface DockMessage extends ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
}

export interface DockEvent {
  kind: "started" | "delta" | "reasoning" | "done" | "error" | "activity";
  text?: string;
  message?: string;
  messages?: DockMessage[];
  /** `null` ends the turn's status line; a string is the next thing it is doing. */
  label?: string | null;
}

/**
 * Everything the dock needs from the product it lives in.
 *
 * The dock is the same chat as the chat app: it lists the same conversations
 * and talks to the same backend commands. The product supplies the transport,
 * so nothing here knows whether it is running inside Hook or Hook Workspace.
 */
export interface DockReport {
  chatId: string;
  messageId: string;
  reason: string;
  note: string | null;
  content: string;
  transcript: { role: "user" | "assistant"; content: string }[] | null;
}

export interface ChatTransport {
  listChats(): Promise<DockChat[]>;
  getChat(id: string): Promise<{ messages: DockMessage[] }>;
  send(chatId: string | null, text: string): Promise<string>;
  stop(chatId: string): Promise<void>;
  subscribe(listener: (chatId: string, event: DockEvent) => void): () => void;
  /** Optional: full-text search. Without it the list filters by title. */
  searchChats?(query: string): Promise<DockChat[]>;
  /**
   * Send a report about a reply (Store policy 11.16). A product that shows
   * generated text must provide it; without it the Report action is hidden
   * rather than shown and broken.
   */
  report?(input: DockReport): Promise<void>;
}

/**
 * The right-hand chat, collapsed by default.
 *
 * It is the chat window at 380px, not a reduced version of it: the same
 * greeting, the same conversation list behind one button, the same thread and
 * composer. The history covers the conversation while it is open — a panel
 * inside a panel has no room to show both, and picking a chat is a decision
 * that ends the moment you make it.
 */
export function ChatDock({
  transport,
  open,
  onClose,
  title = "Hook",
  suggestions = [],
  blurb = "Ask anything. Hook can read what you are looking at.",
}: {
  transport: ChatTransport;
  open: boolean;
  onClose: () => void;
  /** Said to a screen reader only: the dock never prints the product's name. */
  title?: string;
  /** Three things worth asking here, offered on the empty screen. */
  suggestions?: string[];
  /** One line under the greeting, in the product's words. */
  blurb?: string;
}) {
  const [chats, setChats] = useState<DockChat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DockMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [activity, setActivity] = useState<string[] | null>(null);
  // A turn is running while the activity line exists, which outlives each
  // model call: the line is what keeps the panel honest during tools.
  const busy = activity !== null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DockChat[] | null>(null);
  const [reporting, setReporting] = useState<DockMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const pending = useRef("");
  const frame = useRef<number | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const refreshChats = useCallback(async () => {
    try {
      setChats(await transport.listChats());
    } catch {
      // A list that cannot load is not worth an error banner; the next send
      // will surface the real problem.
    }
  }, [transport]);

  useEffect(() => {
    if (!open) return;
    void refreshChats();
  }, [open, refreshChats]);

  // Escape closes the conversation list, the way it closes a sheet.
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  // Search: the backend's own search when the product offers one, the titles
  // otherwise. Debounced, because every keystroke is an IPC round-trip.
  useEffect(() => {
    if (!historyOpen) return;
    const needle = query.trim();
    if (!needle) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      const fallback = chats.filter((chat) =>
        (chat.title || "New chat").toLowerCase().includes(needle.toLowerCase()),
      );
      if (!transport.searchChats) {
        setHits(fallback);
        return;
      }
      void transport
        .searchChats(needle)
        .then((results) => {
          if (alive) setHits(results);
        })
        .catch(() => {
          if (alive) setHits(fallback);
        });
    }, 140);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, historyOpen, chats, transport]);

  // Streaming: the backend sends coalesced text; append it on the next frame.
  useEffect(() => {
    if (!open) return;
    const flush = () => {
      frame.current = null;
      const text = pending.current;
      pending.current = "";
      if (!text) return;
      setMessages((current) => {
        if (current.length === 0) return current;
        const next = [...current];
        const last = next.length - 1;
        next[last] = { ...next[last], content: next[last].content + text };
        return next;
      });
    };
    const unsubscribe = transport.subscribe((chatId, event) => {
      if (chatId !== activeRef.current && activeRef.current !== null) {
        // Another conversation finished in the background: keep the list fresh.
        void refreshChats();
        return;
      }
      switch (event.kind) {
        case "started":
          if (chatId !== activeRef.current) {
            activeRef.current = chatId;
            setActiveId(chatId);
          }
          setMessages(visible(event.messages ?? []));
          setActivity((current) => current ?? []);
          break;
        case "activity": {
          const label = event.label ?? null;
          setActivity((current) => (label ? [...(current ?? []), label] : null));
          break;
        }
        case "delta":
          pending.current += event.text ?? "";
          if (frame.current === null) frame.current = requestAnimationFrame(flush);
          break;
        case "reasoning":
          break;
        case "done": {
          if (event.messages) setMessages(visible(event.messages));
          // A reply that ended in a tool call hands the turn to the next model
          // call; anything else is the end of it, and the line goes with it
          // rather than waiting for the turn's final event.
          const last = [...(event.messages ?? [])]
            .reverse()
            .find((message) => message.role === "assistant");
          if (!last || !last.toolCalls?.length) setActivity(null);
          void refreshChats();
          break;
        }
        case "error":
          if (event.messages) setMessages(visible(event.messages));
          setError(event.message ?? "The reply failed.");
          setActivity(null);
          void refreshChats();
          break;
      }
    });
    return () => {
      unsubscribe();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      pending.current = "";
    };
  }, [open, transport, refreshChats]);

  const openChat = async (id: string) => {
    setHistoryOpen(false);
    setQuery("");
    setError(null);
    try {
      const chat = await transport.getChat(id);
      setActiveId(id);
      activeRef.current = id;
      setMessages(visible(chat.messages));
    } catch (failure) {
      setError(String(failure));
    }
  };

  const startNew = () => {
    setActiveId(null);
    activeRef.current = null;
    setMessages([]);
    setActivity(null);
    setError(null);
    setHistoryOpen(false);
    setQuery("");
    setFocusTick((value) => value + 1);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    setActivity([]);
    // Optimistic echo: the backend's "started" event replaces this list with
    // the authoritative one a moment later.
    setMessages((current) => [
      ...current,
      { id: `local-${current.length}`, role: "user", content: text },
    ]);
    try {
      const chatId = await transport.send(activeRef.current, text);
      if (chatId !== activeRef.current) {
        activeRef.current = chatId;
        setActiveId(chatId);
      }
      void refreshChats();
    } catch (failure) {
      setActivity(null);
      setError(String(failure));
    }
  };

  if (!open) return null;

  const activeChat = chats.find((chat) => chat.id === activeId) ?? null;
  const listed = hits ?? chats;

  return (
    <aside className="dock" aria-label={`${title} chat`}>
      <header className="dock-head" data-tauri-drag-region>
        <button
          className="dock-heading"
          title="Conversations"
          aria-label="Conversations"
          aria-expanded={historyOpen}
          data-active={historyOpen}
          onClick={() => {
            setHistoryOpen((value) => !value);
            setQuery("");
            void refreshChats();
          }}
        >
          <List strokeWidth={1.9} />
          {activeChat ? <span className="dock-title">{activeChat.title}</span> : null}
        </button>
        <div className="dock-actions">
          <button
            className="icon-btn"
            title="Hide Hook"
            aria-label="Hide Hook"
            onClick={onClose}
          >
            <X strokeWidth={1.9} />
          </button>
        </div>
      </header>

      {historyOpen ? (
        <div className="dock-panel">
          <label className="dock-search">
            <Search strokeWidth={1.9} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              autoFocus
              spellCheck={false}
            />
            {query ? (
              <button className="dock-search-clear" onClick={() => setQuery("")} aria-label="Clear">
                <X strokeWidth={2} />
              </button>
            ) : null}
          </label>

          <button className="dock-panel-new" onClick={startNew}>
            <SquarePen strokeWidth={1.8} />
            New chat
          </button>

          <div className="dock-panel-list">
            {listed.length === 0 ? (
              <p className="dock-panel-empty">
                {query ? "Nothing matches that." : "No chats yet."}
              </p>
            ) : (
              groupChats(listed).map((group) => (
                <div className="dock-group" key={group.label}>
                  <div className="dock-group-label">{group.label}</div>
                  {group.items.map((chat) => (
                    <button
                      key={chat.id}
                      className="dock-history-row"
                      data-active={chat.id === activeId}
                      onClick={() => void openChat(chat.id)}
                    >
                      <span>{chat.title || "New chat"}</span>
                      <time>{recent(chat.updatedAt)}</time>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      ) : messages.length === 0 && !busy ? (
        <div className="dock-hero">
          <HookMark className="dock-hero-mark" />
          <h1>{greeting()}</h1>
          <p>{blurb}</p>
          {suggestions.length > 0 ? (
            <div className="dock-chips">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  className="dock-chip"
                  onClick={() => {
                    setDraft(suggestion);
                    setFocusTick((value) => value + 1);
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <Thread
          className="dock-thread"
          messages={messages}
          activity={activity ?? undefined}
          onReport={
            transport.report
              ? (message) => {
                  if (activeRef.current) setReporting(message);
                }
              : undefined
          }
        />
      )}

      {error && (
        <div className="dock-error" role="alert">
          {error}
        </div>
      )}

      {reporting && transport.report && activeRef.current && (
        <ReportDialog
          messages={messages}
          onClose={() => setReporting(null)}
          submit={(input) =>
            transport.report!({
              chatId: activeRef.current!,
              messageId: reporting.id,
              reason: input.reason,
              note: input.note,
              content: reporting.content,
              transcript: input.transcript,
            })
          }
        />
      )}

      {historyOpen ? null : (
        <div className="dock-composer">
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => void send()}
            onStop={() => {
              if (activeId) void transport.stop(activeId);
            }}
            busy={busy}
            placeholder="Ask anything…"
            focusKey={`${activeId ?? "new"}-${focusTick}`}
          />
        </div>
      )}
    </aside>
  );
}

function visible(messages: DockMessage[]): DockMessage[] {
  return messages.filter(
    (message) => !message.hidden && message.role !== "system" && message.role !== "tool",
  );
}

function recent(timestamp: number): string {
  if (!timestamp) return "";
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Today / Yesterday / Earlier, the way the chat window groups them. */
function groupChats(chats: DockChat[]): Array<{ label: string; items: DockChat[] }> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets = [
    { label: "Today", items: [] as DockChat[] },
    { label: "Yesterday", items: [] as DockChat[] },
    { label: "Earlier", items: [] as DockChat[] },
  ];
  for (const chat of chats) {
    if (chat.updatedAt >= startOfToday) buckets[0].items.push(chat);
    else if (chat.updatedAt >= startOfToday - 86_400_000) buckets[1].items.push(chat);
    else buckets[2].items.push(chat);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}
