import { useCallback, useEffect, useRef, useState } from "react";
import { List, Loader2, Send, Square, SquarePen, X } from "lucide-react";

import { Markdown } from "./Markdown";
import "./dock.css";

export interface DockChat {
  id: string;
  title: string;
  updatedAt: number;
}

export interface DockMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status?: string;
  hidden?: boolean;
}

export interface DockEvent {
  kind: "started" | "delta" | "reasoning" | "done" | "error";
  text?: string;
  message?: string;
  messages?: DockMessage[];
}

/**
 * Everything the dock needs from the product it lives in.
 *
 * The dock is the same chat as the chat app: it lists the same conversations
 * and talks to the same backend commands. The product supplies the transport,
 * so nothing here knows whether it is running inside Hook or Hook Workspace.
 */
export interface ChatTransport {
  listChats(): Promise<DockChat[]>;
  getChat(id: string): Promise<{ messages: DockMessage[] }>;
  send(chatId: string | null, text: string): Promise<string>;
  stop(chatId: string): Promise<void>;
  subscribe(listener: (chatId: string, event: DockEvent) => void): () => void;
}

/**
 * The right-hand chat, collapsed by default.
 *
 * No preview: a docked panel is too narrow for a page, and every product will
 * eventually offer its own way to look at things. The conversation list is
 * collapsed too — you are here to ask one question, not to browse history.
 */
export function ChatDock({
  transport,
  open,
  onClose,
  title = "Hook",
}: {
  transport: ChatTransport;
  open: boolean;
  onClose: () => void;
  title?: string;
}) {
  const [chats, setChats] = useState<DockChat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DockMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
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
          setBusy(true);
          break;
        case "delta":
          pending.current += event.text ?? "";
          if (frame.current === null) frame.current = requestAnimationFrame(flush);
          break;
        case "reasoning":
          break;
        case "done":
        case "error":
          if (event.messages) setMessages(visible(event.messages));
          if (event.kind === "error") setError(event.message ?? "The reply failed.");
          setBusy(false);
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

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  const openChat = async (id: string) => {
    setHistoryOpen(false);
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
    setError(null);
    setHistoryOpen(false);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setError(null);
    setBusy(true);
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
      setBusy(false);
      setError(String(failure));
    }
  };

  if (!open) return null;

  const activeChat = chats.find((chat) => chat.id === activeId) ?? null;

  return (
    <aside className="dock" aria-label="Hook chat">
      <header className="dock-head" data-tauri-drag-region>
        <span className="dock-title">{activeChat?.title || title}</span>
        <div className="dock-actions">
          <button
            className="icon-btn"
            title="Conversations"
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryOpen((value) => !value);
              void refreshChats();
            }}
          >
            <List strokeWidth={1.9} />
          </button>
          <button className="icon-btn" title="New chat" onClick={startNew}>
            <SquarePen strokeWidth={1.8} />
          </button>
          <button className="icon-btn" title="Hide Hook" onClick={onClose}>
            <X strokeWidth={1.9} />
          </button>
        </div>
      </header>

      {historyOpen && (
        <div className="dock-history" role="dialog" aria-label="Conversations">
          <div className="dock-history-head">Conversations</div>
          {chats.length === 0 && <p className="dock-history-empty">No chats yet.</p>}
          {chats.map((chat) => (
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
      )}

      <div className="dock-thread" ref={scroller}>
        {messages.length === 0 ? (
          <div className="dock-empty">
            <p>Ask about what you are looking at.</p>
            <span>
              Hook can read this project, its boards and documents, and change
              them for you.
            </span>
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className="dock-message"
              data-role={message.role}
              data-streaming={message.status === "streaming" ? "true" : undefined}
            >
              {message.role === "user" ? (
                <p className="dock-user-text">{message.content}</p>
              ) : (
                <Markdown
                  content={message.content}
                  streaming={message.status === "streaming"}
                />
              )}
            </article>
          ))
        )}
        {busy && messages[messages.length - 1]?.role === "user" && (
          <div className="dock-thinking">
            <Loader2 className="dock-spin" />
            Thinking
          </div>
        )}
      </div>

      {error && (
        <div className="dock-error" role="alert">
          {error}
        </div>
      )}

      <div className="dock-composer">
        <textarea
          className="dock-input"
          rows={1}
          value={draft}
          placeholder="Ask Hook…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <button
            className="dock-send"
            title="Stop"
            onClick={() => {
              if (activeId) void transport.stop(activeId);
            }}
          >
            <Square strokeWidth={2} />
          </button>
        ) : (
          <button
            className="dock-send"
            title="Send"
            disabled={!draft.trim()}
            onClick={() => void send()}
          >
            <Send strokeWidth={1.9} />
          </button>
        )}
      </div>
    </aside>
  );
}

function visible(messages: DockMessage[]): DockMessage[] {
  return messages.filter(
    (message) => !message.hidden && message.role !== "system" && message.role !== "tool",
  );
}

function recent(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (!timestamp) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
