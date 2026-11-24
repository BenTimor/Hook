import { useState } from "react";
import { ChevronDown, Layers } from "lucide-react";

import { Markdown } from "./Markdown";
import type { ChatCompaction, ChatMessage } from "./types";

/** `312_400` → "312k". Small numbers stay exact, because they are rare. */
function tokens(value: number): string {
  if (value <= 0) return "";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function label(info: ChatCompaction | undefined, streaming: boolean): string {
  if (streaming) return "Compacting the conversation…";
  const folded = info?.messages
    ? `${info.messages} ${info.messages === 1 ? "message" : "messages"} folded into a summary`
    : "Older turns folded into a summary";
  return folded;
}

export interface CompactionItemProps<M extends ChatMessage> {
  message: M;
}

/**
 * The compaction as advanced mode draws it: where the context was cut, how much
 * went, and the summary every later request starts from. The simple view never
 * reaches this component — a reader who did not ask for the machinery only sees
 * the thinking line while it happens.
 */
export function CompactionItem<M extends ChatMessage>({ message }: CompactionItemProps<M>) {
  const [open, setOpen] = useState(false);
  const streaming = message.status === "streaming";
  const info = message.compaction;
  const summary = message.content.trim();
  const before = tokens(info?.tokensBefore ?? 0);
  const after = tokens(info?.tokensAfter ?? 0);

  return (
    <div className="compaction" data-live={streaming || undefined}>
      <button
        type="button"
        className="compaction-head"
        onClick={() => summary && setOpen((value) => !value)}
        aria-expanded={summary ? open : undefined}
        disabled={!summary || streaming}
      >
        <Layers className="compaction-icon" strokeWidth={1.9} />
        <span className="compaction-label">{label(info, streaming)}</span>
        {before && after ? (
          <span className="compaction-tokens">
            {before} → {after} tokens
          </span>
        ) : null}
        {summary ? (
          <ChevronDown
            className="compaction-chevron"
            data-open={open || undefined}
            strokeWidth={2.1}
          />
        ) : null}
      </button>
      {open && summary ? (
        <div className="compaction-body">
          <Markdown content={summary} />
        </div>
      ) : null}
    </div>
  );
}
