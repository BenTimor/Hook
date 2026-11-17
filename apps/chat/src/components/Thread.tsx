import { useEffect, useMemo, useRef } from "react";

import { useChatStore } from "../store/useChatStore";
import { MessageItem } from "./MessageItem";

export function Thread() {
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const streamText = useChatStore((s) =>
    s.activeId ? s.streams[s.activeId]?.text : undefined,
  );
  const regenerate = useChatStore((s) => s.regenerate);
  const edit = useChatStore((s) => s.edit);

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
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

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
      className="thread"
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
            onRegenerate={() => void regenerate()}
            onEdit={(id, text) => void edit(id, text)}
          />
        ))}
      </div>
    </div>
  );
}
