import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Copy, Flag, Pencil, RefreshCw } from "lucide-react";

import type { Message } from "../lib/types";
import { copyText } from "../lib/utils";
import { useChatStore } from "../store/useChatStore";
import { Markdown } from "./Markdown";
import { MessageImages } from "./MessageImages";
import { ReportDialog } from "./ReportDialog";

interface Props {
  message: Message;
  streamText?: string;
  isLastAssistant: boolean;
  onRegenerate: () => void;
  onEdit: (id: string, text: string) => void;
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

export function MessageItem({
  message,
  streamText,
  isLastAssistant,
  onRegenerate,
  onEdit,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const chatId = useChatStore((s) => s.activeId);
  const [editText, setEditText] = useState(message.content);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const streaming = message.status === "streaming";
  const body = streaming && streamText !== undefined ? streamText : message.content;
  const empty = streaming && !body;

  const copy = async () => {
    if (await copyText(body)) {
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
                    onEdit(message.id, editText.trim());
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
                  onEdit(message.id, editText.trim());
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
        <MessageImages message={message} />
        {message.content.trim() && <div className="bubble">{message.content}</div>}
        <div className="msg-actions">
          <button className="mini-btn" onClick={() => void copy()}>
            {copied ? <Check strokeWidth={2.2} /> : <Copy strokeWidth={1.9} />}
            {copied ? "Copied" : "Copy"}
          </button>
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
        </div>
      </div>
    );
  }

  return (
    <div className="msg" data-role="assistant">
      {empty ? (
        <ThinkingDots />
      ) : (
        <Markdown content={body} streaming={streaming} />
      )}

      <MessageImages message={message} />

      {message.status === "error" && message.error && (
        <div className="msg-error">
          <AlertCircle strokeWidth={1.9} />
          <span>{message.error}</span>
        </div>
      )}
      {message.status === "aborted" && <div className="aborted-note">Stopped</div>}

      <div className="msg-actions">
        <button className="mini-btn" onClick={() => void copy()}>
          {copied ? <Check strokeWidth={2.2} /> : <Copy strokeWidth={1.9} />}
          {copied ? "Copied" : "Copy"}
        </button>
        {isLastAssistant && !streaming && (
          <button className="mini-btn" onClick={onRegenerate}>
            <RefreshCw strokeWidth={1.8} />
            Regenerate
          </button>
        )}
        {!streaming && message.content.trim() && chatId && (
          <button className="mini-btn" onClick={() => setReporting(true)}>
            <Flag strokeWidth={1.8} />
            Report
          </button>
        )}
      </div>

      {reporting && chatId ? (
        <ReportDialog
          chatId={chatId}
          message={message}
          onClose={() => setReporting(false)}
        />
      ) : null}
    </div>
  );
}
