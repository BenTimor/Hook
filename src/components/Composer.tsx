import { useEffect, useRef, useState } from "react";
import { ArrowUp, CornerDownLeft, Square } from "lucide-react";

import { useChatStore } from "../store/useChatStore";

export function Composer() {
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const activeId = useChatStore((s) => s.activeId);
  const streaming = useChatStore((s) => (s.activeId ? Boolean(s.streams[s.activeId]) : false));
  const ready = useChatStore((s) => s.ready);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const focusToken = useChatStore((s) => s.focusToken);

  const ref = useRef<HTMLTextAreaElement>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);

  useEffect(() => {
    if (focusToken > 0) ref.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    ref.current?.focus();
  }, [activeId]);

  const submit = () => {
    const text = draft.trim();
    if (!text || !ready || streaming) return;
    void send(text);
    if (ref.current) ref.current.style.height = "auto";
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          spellCheck={false}
          placeholder="Ask anything…"
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !composing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button
            className="send-btn"
            data-stop="true"
            title="Stop generating"
            aria-label="Stop generating"
            onClick={() => void stop()}
          >
            <Square strokeWidth={2.4} fill="currentColor" />
          </button>
        ) : (
          <button
            className="send-btn"
            title="Send"
            aria-label="Send"
            disabled={!draft.trim() || !ready}
            onClick={submit}
          >
            <ArrowUp strokeWidth={2.2} />
          </button>
        )}
      </div>
      <div className="composer-hint" data-active={draft.trim().length > 0}>
        <CornerDownLeft size={10} style={{ display: "inline", verticalAlign: "-1px" }} /> Enter to
        send · Shift + Enter for a new line
      </div>
    </div>
  );
}
