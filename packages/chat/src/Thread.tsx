import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { MessageItem } from "./MessageItem";
import { TurnActivity } from "./TurnActivity";
import { WorkGroup } from "./WorkSteps";
import { buildBlocks } from "./turns";
import type { ChatMessage } from "./types";
import "./chat.css";

export interface ThreadProps<M extends ChatMessage> {
  messages: M[];
  /** The text of the reply that is still arriving, if there is one. */
  streamText?: string;
  /** The reasoning of the reply that is still arriving, when the provider sends it. */
  streamReasoning?: string;
  /**
   * What the running turn is doing, oldest label first. Undefined means no
   * turn is running here; an empty array means the turn started and has not
   * picked a tool yet, which reads as "Thinking".
   */
  activity?: string[];
  /**
   * Advanced mode: show the model's thinking and tool calls, and the coding
   * agents' work, instead of only the answers.
   */
  showDetails?: boolean;
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
  streamReasoning,
  activity,
  showDetails,
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

  // A turn's thinking and tool calls fold into one block above its answer.
  // Without advanced mode the builder drops that traffic before it can reach
  // the screen, so this is also the place that guarantees no tool result is
  // drawn by accident.
  const blocks = useMemo(
    () =>
      buildBlocks(messages, {
        showDetails: Boolean(showDetails),
        streamText,
        streamReasoning,
        turnRunning: activity !== undefined,
      }),
    [messages, showDetails, streamText, streamReasoning, activity],
  );

  const last = blocks[blocks.length - 1];
  // "Text arriving" means text the user can read, not a reply that merely
  // exists: a streaming message spends its first seconds empty, and a thinking
  // model can spend many. The activity line is what fills that gap, so it
  // steps aside only once there is something to read.
  const streamingAnswer =
    last?.type === "answer" &&
    last.message?.role === "assistant" &&
    last.message.status === "streaming"
      ? last.message
      : undefined;
  const textArriving = (streamText ?? streamingAnswer?.content ?? "").trim() !== "";
  const showActivity = activity !== undefined && !textArriving;

  const lastAssistantId = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (block.type === "answer" && block.message) return block.message.id;
    }
    return null;
  }, [blocks]);

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
    // The container changes height when the window resizes or the phone's
    // keyboard opens. A reader who was at the bottom should stay there; one
    // who had scrolled up must not be dragged down.
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (blocks.length > prevCount.current) {
      const last = blocks[blocks.length - 1];
      if (last?.type === "message" && last.message.role === "user") {
        stick.current = true;
      }
    }
    prevCount.current = blocks.length;
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks, streamText, streamReasoning]);

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
        {blocks.map((block) => {
          if (block.type === "message") {
            return (
              <MessageItem
                key={block.key}
                message={block.message}
                isLastAssistant={false}
                onEdit={onEdit}
                renderExtras={renderExtras}
              />
            );
          }

          const message = block.message;
          const streaming = message?.status === "streaming";
          const body =
            streaming && streamText !== undefined
              ? streamText
              : (message?.content ?? "");
          // The activity line is the empty streaming reply's place. With
          // advanced mode its thinking still belongs above it.
          const emptyStreaming = streaming && !body;

          if (!message || emptyStreaming) {
            return block.steps.length ? (
              <div className="msg" data-role="assistant" key={block.key}>
                <WorkGroup steps={block.steps} live={block.live} />
              </div>
            ) : null;
          }

          return (
            <MessageItem
              key={block.key}
              message={message}
              steps={block.steps}
              workLive={block.live}
              streamText={streaming ? streamText : undefined}
              isLastAssistant={message.id === lastAssistantId}
              onRegenerate={onRegenerate}
              onReport={onReport}
              renderExtras={renderExtras}
            />
          );
        })}
        {showActivity ? <TurnActivity labels={activity} /> : null}
      </div>
    </div>
  );
}
