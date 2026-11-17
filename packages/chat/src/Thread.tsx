import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { MessageItem } from "./MessageItem";
import type { ChatMessage } from "./types";
import "./chat.css";

export interface ThreadProps<M extends ChatMessage> {
  messages: M[];
  /** The text of the reply that is still arriving, if there is one. */
  streamText?: string;
  onRegenerate?: () => void;
  onEdit?: (id: string, text: string) => void;
  onReport?: (message: M) => void;
  renderExtras?: (message: M) => ReactNode;
  /** Extra classes for the scroller, so a dock can restyle it. */
  className?: string;
}

/**
 * The conversation. It owns the scroller and the one hard part of a chat UI:
 * staying pinned to the bottom while tokens arrive and code highlights land,
 * but getting out of the way as soon as you scroll up.
 */
export function Thread<M extends ChatMessage>({
  messages,
  streamText,
  onRegenerate,
  onEdit,
  onReport,
  renderExtras,
  className,
}: ThreadProps<M>) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevCount = useRef(messages.length);

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    const inner = innerRef.current;
    const el = ref.current;
    if (!inner || !el) return;
    // Async code highlighting changes the content height after render; keep the
    // viewport pinned when the user is at the bottom.
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (messages.length > prevCount.current) {
      const last = messages[messages.length - 1];
      if (last?.role === "user") stick.current = true;
    }
    prevCount.current = messages.length;
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamText]);

  return (
    <div
      className={className ? `thread ${className}` : "thread"}
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
      }}
    >
      <div className="thread-inner" ref={innerRef}>
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            streamText={message.status === "streaming" ? streamText : undefined}
            isLastAssistant={message.id === lastAssistantId}
            onRegenerate={onRegenerate}
            onEdit={onEdit}
            onReport={onReport}
            renderExtras={renderExtras}
          />
        ))}
      </div>
    </div>
  );
}
