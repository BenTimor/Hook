import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { MessageItem } from "./MessageItem";
import { TurnActivity } from "./TurnActivity";
import type { ChatMessage } from "./types";
import "./chat.css";

export interface ThreadProps<M extends ChatMessage> {
  messages: M[];
  /** The text of the reply that is still arriving, if there is one. */
  streamText?: string;
  /**
   * What the running turn is doing, oldest label first. Undefined means no
   * turn is running here; an empty array means the turn started and has not
   * picked a tool yet, which reads as "Thinking".
   */
  activity?: string[];
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
  activity,
  onRegenerate,
  onEdit,
  onReport,
  renderExtras,
  className,
}: ThreadProps<M>) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevCount = useRef(0);

  // Tool traffic is history, not conversation. The store already drops it, but
  // this is the one place every product renders through, so the guarantee
  // belongs here too: no caller can put a tool result on screen by accident.
  // An empty streaming reply is the activity line's place, not a blank bubble
  // with actions under it, so it is left to `TurnActivity`.
  const shown = useMemo(
    () =>
      messages.filter(
        (message) =>
          !message.hidden &&
          message.role !== "tool" &&
          message.role !== "system" &&
          !(
            message.role === "assistant" &&
            message.status === "streaming" &&
            !(streamText !== undefined ? streamText : message.content)
          ),
      ),
    [messages, streamText],
  );

  const last = shown[shown.length - 1];
  const textArriving =
    Boolean(streamText) ||
    (last?.role === "assistant" && last.status === "streaming");
  const showActivity = activity !== undefined && !textArriving;

  const lastAssistantId = useMemo(() => {
    for (let i = shown.length - 1; i >= 0; i -= 1) {
      if (shown[i].role === "assistant") return shown[i].id;
    }
    return null;
  }, [shown]);

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
    if (shown.length > prevCount.current) {
      const last = shown[shown.length - 1];
      if (last?.role === "user") stick.current = true;
    }
    prevCount.current = shown.length;
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown, streamText]);

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
        {shown.map((message) => (
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
        {showActivity ? <TurnActivity labels={activity} /> : null}
      </div>
    </div>
  );
}
