import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { MessageItem } from "./MessageItem";
import { TurnActivity } from "./TurnActivity";
import { WorkGroup } from "./WorkSteps";
import { buildBlocks, type AnswerTextPart } from "./turns";
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
  /**
   * The simple view draws only the turn's last message. A direct coding chat
   * turns this off, because its engine was not told the rule; every visible
   * message is drawn instead.
   */
  finalOnly?: boolean;
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
  finalOnly = true,
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

  // A turn keeps the order it happened in: a message, the work it set off,
  // then the next message. Without advanced mode the builder drops everything
  // but the turn's last message, so this is also the place that guarantees no
  // tool result or earlier message is drawn by accident. A direct coding chat
  // opts out of "last message only" because its engine was not told the rule.
  const blocks = useMemo(
    () =>
      buildBlocks(messages, {
        showDetails: Boolean(showDetails),
        finalOnly: finalOnly !== false,
        streamText,
        streamReasoning,
        turnRunning: activity !== undefined,
      }),
    [messages, showDetails, finalOnly, streamText, streamReasoning, activity],
  );

  const last = blocks[blocks.length - 1];
  // "Text arriving" means the reply that is streaming right now has words the
  // user can read. A reply spends its first seconds empty, and a thinking model
  // can spend many, so the activity line fills that gap. Text already on screen
  // from an earlier message does not hide what the current step is doing.
  const lastPart =
    last?.type === "answer" ? last.parts[last.parts.length - 1] : undefined;
  const textArriving =
    lastPart?.kind === "text" &&
    lastPart.message.status === "streaming" &&
    lastPart.text.trim() !== "";
  const showActivity = activity !== undefined && !textArriving;

  const lastAnswerKey = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i];
      if (block.type === "answer") return block.key;
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

          // An empty streaming reply belongs to the activity line. Drawing it
          // here as well is the duplicate "Thinking" the simple view showed.
          const parts = block.parts.filter(
            (part) =>
              part.kind === "work" ||
              part.message.status !== "streaming" ||
              part.text.trim() !== "",
          );
          // A message with an error or a stop note that has no text of its own
          // still needs somewhere to say so, after the text the turn did write.
          const message = block.message;
          const lastText = [...parts]
            .reverse()
            .find((part): part is AnswerTextPart<M> => part.kind === "text");
          const tailStatus =
            message !== undefined &&
            (message.status === "error" || message.status === "aborted") &&
            lastText?.message.id !== message.id;

          if (parts.length === 0 && !tailStatus) return null;

          return (
            <div className="answer-turn" key={block.key}>
              {parts.map((part) => {
                if (part.kind === "work") {
                  return (
                    <div
                      className="msg"
                      data-role="assistant"
                      data-actions="false"
                      key={part.key}
                    >
                      <WorkGroup steps={part.steps} live={part.live} />
                    </div>
                  );
                }
                const last = part === lastText;
                const lastPart = part === parts[parts.length - 1];
                return (
                  <MessageItem
                    key={part.key}
                    message={part.message}
                    text={part.text}
                    showActions={last && lastPart && !tailStatus}
                    isLastAssistant={
                      last && lastPart && block.key === lastAnswerKey && !block.live
                    }
                    onRegenerate={last ? onRegenerate : undefined}
                    onReport={last ? onReport : undefined}
                    renderExtras={renderExtras}
                  />
                );
              })}
              {tailStatus && message ? (
                <MessageItem
                  key={`${block.key}-status`}
                  message={message}
                  text=""
                  showActions={false}
                  isLastAssistant={false}
                  renderExtras={renderExtras}
                />
              ) : null}
            </div>
          );
        })}
        {showActivity ? <TurnActivity labels={activity} /> : null}
      </div>
    </div>
  );
}
