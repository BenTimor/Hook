import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, Copy, Flag, Pencil, RefreshCw } from "lucide-react";

import { copyableMarkdown } from "@hook/markdown";

import { copyText } from "./clipboard";
import { Markdown } from "./Markdown";
import { WorkGroup, type WorkStep } from "./WorkSteps";
import type { ChatMessage } from "./types";
import "./chat.css";

export interface MessageItemProps<M extends ChatMessage> {
  message: M;
  /**
   * The text to draw for this part. The turn builder composes it, so it can be
   * newer than `message.content` while a reply is still streaming.
   */
  text?: string;
  /** The text of a reply that is still arriving, if this is the one streaming. */
  streamText?: string;
  /** Thinking and tool calls that led to this reply, folded above it. */
  steps?: WorkStep[];
  /** The turn is still running, so the work block stays open for now. */
  workLive?: boolean;
  /** Copy/Regenerate/Report belong to the turn's last message, not to every one. */
  showActions?: boolean;
  isLastAssistant?: boolean;
  onRegenerate?: () => void;
  onEdit?: (id: string, text: string) => void;
  onReport?: (message: M) => void;
  /**
   * Pictures and anything else a product renders around the text. It is called
   * once per message, in the place attachments belong for that role.
   */
  renderExtras?: (message: M) => ReactNode;
}

function ThinkingDots() {
  return (
    <div className="thinking">
      <span className="thinking-dot">
        <i />
        <i />
        <i />
      </span>
      Thinking
    </div>
  );
}

/**
 * One message: a bubble for what you said, Markdown for what Hook said, and the
 * actions that belong to each. It knows nothing about a store or a transport —
 * a product decides what Regenerate and Report mean, or omits them.
 */
export function MessageItem<M extends ChatMessage>({
  message,
  text,
  streamText,
  steps,
  workLive,
  showActions,
  isLastAssistant,
  onRegenerate,
  onEdit,
  onReport,
  renderExtras,
}: MessageItemProps<M>) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const streaming = message.status === "streaming";
  const body =
    text ??
    (streaming && streamText !== undefined ? streamText : message.content);
  const empty = streaming && !body;

  const copy = async () => {
    // A reply's direction fences are structure, not text: the copy is the
    // message without them. What the user typed is already plain text.
    const text = message.role === "assistant" ? copyableMarkdown(body) : body;
    if (await copyText(text)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }
  };

  if (message.role === "user") {
    if (editing) {
      return (
        <div className="msg" data-role="user">
          <div className="edit-area">
            <textarea
              autoFocus
              value={editText}
              spellCheck={false}
              onChange={(event) => setEditText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (editText.trim()) {
                    setEditing(false);
                    onEdit?.(message.id, editText.trim());
                  }
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                  setEditText(message.content);
                }
              }}
            />
            <div className="edit-actions">
              <button
                className="pill-btn"
                onClick={() => {
                  setEditing(false);
                  setEditText(message.content);
                }}
              >
                Cancel
              </button>
              <button
                className="pill-btn"
                data-primary="true"
                disabled={!editText.trim()}
                onClick={() => {
                  setEditing(false);
                  onEdit?.(message.id, editText.trim());
                }}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="msg" data-role="user">
        {renderExtras?.(message)}
        {/* `dir="auto"` is the browser's first-strong-character rule: a message
            written in Hebrew or Arabic is laid out right to left, one that opens
            with a digit, a quote or an emoji still gets it right, and nothing
            here has to know which languages those are. */}
        {message.content.trim() && (
          <div className="bubble" dir="auto">
            {message.content}
          </div>
        )}
        <div className="msg-actions">
          <button className="mini-btn" onClick={() => void copy()}>
            {copied ? <Check strokeWidth={2.2} /> : <Copy strokeWidth={1.9} />}
            {copied ? "Copied" : "Copy"}
          </button>
          {onEdit && (
            <button
              className="mini-btn"
              onClick={() => {
                setEditText(message.content);
                setEditing(true);
              }}
            >
              <Pencil strokeWidth={1.8} />
              Edit
            </button>
          )}
        </div>
      </div>
    );
  }

  // A picture Hook made or the user attached: the pictures are the message,
  // and what the tool wrote above them is a caption, not something to copy,
  // edit or report.
  if (message.role === "picture") {
    const caption = message.content.trim();
    return (
      <div className="msg" data-role="picture">
        {renderExtras?.(message)}
        {caption && (
          <div className="msg-caption" dir="auto">
            {caption}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="msg"
      data-role="assistant"
      data-actions={showActions === false ? "false" : undefined}
    >
      {steps && steps.length > 0 && <WorkGroup steps={steps} live={workLive} />}

      {empty ? <ThinkingDots /> : <Markdown content={body} streaming={streaming} />}

      {renderExtras?.(message)}

      {message.status === "error" && message.error && (
        <div className="msg-error">
          <AlertCircle strokeWidth={1.9} />
          <span>{message.error}</span>
        </div>
      )}
      {message.status === "aborted" && <div className="aborted-note">Stopped</div>}

      {showActions !== false && (
        <div className="msg-actions">
          <button className="mini-btn" onClick={() => void copy()}>
            {copied ? <Check strokeWidth={2.2} /> : <Copy strokeWidth={1.9} />}
            {copied ? "Copied" : "Copy"}
          </button>
          {isLastAssistant && !streaming && onRegenerate && (
            <button className="mini-btn" onClick={onRegenerate}>
              <RefreshCw strokeWidth={1.8} />
              Regenerate
            </button>
          )}
          {!streaming && body.trim() && onReport && (
            <button className="mini-btn" onClick={() => onReport(message)}>
              <Flag strokeWidth={1.8} />
              Report
            </button>
          )}
        </div>
      )}
    </div>
  );
}
