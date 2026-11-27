import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import { ArrowDown } from "lucide-react";

import { CompactionItem } from "./CompactionItem";
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
  /**
   * The reader scrolled the conversation down with their own finger. A phone
   * uses it to give the screen back to the conversation and drop its keyboard;
   * our own pinning to the bottom is not this, or a reply would close it.
   */
  onScrollDown?: () => void;
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
  onScrollDown,
  className,
}: ThreadProps<M>) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevCount = useRef(0);
  // The last scroll position we wrote ourselves. A container clamps the value
  // it is given, so it is read back rather than assumed.
  const selfTop = useRef(-1);
  const lastTop = useRef(0);
  const jumping = useRef(false);
  const knownUsers = useRef<Set<string>>(new Set());
  const [atBottom, setAtBottom] = useState(true);

  /** Stay at the last message. */
  const pin = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    selfTop.current = el.scrollTop;
    lastTop.current = el.scrollTop;
    setAtBottom(true);
  }, []);

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
  // While a compaction is written, advanced mode already draws the fold itself;
  // a second "Thinking" line under it would say the same thing twice.
  const compacting =
    last?.type === "compaction" && last.message.status === "streaming";
  const showActivity = activity !== undefined && !textArriving && !compacting;

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
      if (stick.current) pin();
    });
    observer.observe(inner);
    // The container changes height when the window resizes or the phone's
    // keyboard opens. A reader who was at the bottom should stay there; one
    // who had scrolled up must not be dragged down.
    observer.observe(el);
    return () => observer.disconnect();
  }, [pin]);

  useEffect(() => {
    // A message the reader wrote is the one thing that always comes back into
    // view: they sent it, so it is what they are looking at. Waiting for the
    // last block to be that message is not enough — a reply's placeholder can
    // land in the same breath, and then the view never moved at all.
    const users = new Set<string>();
    let sent = false;
    for (const block of blocks) {
      if (block.type !== "message") continue;
      const role = block.message.role;
      if (role !== "user" && role !== "picture") continue;
      users.add(block.key);
      if (!knownUsers.current.has(block.key)) sent = true;
    }
    knownUsers.current = users;
    if (blocks.length > prevCount.current && sent) stick.current = true;
    prevCount.current = blocks.length;
    if (stick.current) pin();
  }, [blocks, streamText, streamReasoning, pin]);

  /**
   * Back to the last message, from the arrow a reader uses instead of dragging
   * the scrollbar. The jump is smooth, so the scroll events it produces are not
   * read as the reader leaving the bottom: the arrow would otherwise blink out
   * and back while it travels.
   */
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    jumping.current = true;
    setAtBottom(true);
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
    // A fallback stop for a window that never fires the last scroll event.
    window.setTimeout(() => {
      jumping.current = false;
      if (stick.current) pin();
    }, 600);
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const top = el.scrollTop;
    const previous = lastTop.current;
    lastTop.current = top;
    const bottom = el.scrollHeight - top - el.clientHeight < 72;
    // Our own pinning lands here too. Reading it as the reader scrolling down
    // would close their keyboard every time a reply grew.
    const ours = Math.abs(top - selfTop.current) < 4;
    if (!jumping.current) {
      stick.current = bottom;
      setAtBottom(bottom);
    }
    if (jumping.current || ours || !onScrollDown) return;
    if (top > previous + 12) onScrollDown();
  };

  return (
    <div
      className={className ? `thread ${className}` : "thread"}
      ref={ref}
      onScroll={onScroll}
    >
      <div className="thread-inner" ref={innerRef}>
        {blocks.map((block) => {
          if (block.type === "compaction") {
            return <CompactionItem key={block.key} message={block.message} />;
          }

          if (block.type === "message") {
            const standalone = block.message.role === "picture";
            return (
              <MessageItem
                key={block.key}
                message={block.message}
                showActions={standalone ? false : undefined}
                isLastAssistant={false}
                onEdit={block.message.role === "user" ? onEdit : undefined}
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
      <div className="thread-jump" data-hidden={atBottom || undefined}>
        <button
          type="button"
          className="thread-jump-btn"
          title="Scroll to the last message"
          aria-label="Scroll to the last message"
          tabIndex={atBottom ? -1 : 0}
          onClick={jump}
        >
          <ArrowDown strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
