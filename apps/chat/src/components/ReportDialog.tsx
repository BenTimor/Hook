import { useEffect, useMemo, useState } from "react";
import { Flag, X } from "lucide-react";
import { toast } from "sonner";

import { api } from "../lib/bridge";
import type { Message, ReportMessage, ReportReason } from "../lib/types";
import { useChatStore } from "../store/useChatStore";

const REASONS: { id: ReportReason; label: string }[] = [
  { id: "harmful", label: "Harmful or dangerous" },
  { id: "sexual", label: "Sexual content" },
  { id: "violence", label: "Violence" },
  { id: "hate", label: "Hate or harassment" },
  { id: "other", label: "Something else" },
];

const MAX_TRANSCRIPT_CHARS = 300_000;
const MAX_TRANSCRIPT_MESSAGES = 300;

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The report could not be sent.";
}

/**
 * The conversation to attach when the user opts in. Built from the end so a
 * very long chat still keeps the messages around the reported reply.
 */
function conversation(messages: Message[]): ReportMessage[] {
  const out: ReportMessage[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.hidden) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!message.content.trim()) continue;
    out.unshift({ role: message.role, content: message.content });
    chars += message.content.length;
    if (chars >= MAX_TRANSCRIPT_CHARS || out.length >= MAX_TRANSCRIPT_MESSAGES) {
      break;
    }
  }
  return out;
}

export function ReportDialog({
  chatId,
  message,
  onClose,
}: {
  chatId: string;
  message: Message;
  onClose: () => void;
}) {
  const messages = useChatStore((s) => s.messages);
  const history = useMemo(() => conversation(messages), [messages]);
  const [reason, setReason] = useState<ReportReason>("other");
  const [note, setNote] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await api.reportMessage({
        chatId,
        messageId: message.id,
        reason,
        note: note.trim() || null,
        content: message.content,
        transcript: includeHistory ? history : null,
      });
      toast.success("Report sent. Thank you.");
      onClose();
    } catch (caught) {
      const message = errorText(caught);
      setError(message);
      toast.error(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="report-backdrop" onMouseDown={onClose}>
      <div
        className="report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="report-head">
          <span className="report-icon" aria-hidden="true">
            <Flag strokeWidth={1.8} />
          </span>
          <div className="report-title-copy">
            <h2 id="report-title">Report this reply</h2>
            <p>
              Reports go to Hook for review. The reply is included — never
              include passwords, keys or private data you want to keep.
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X strokeWidth={2} />
          </button>
        </div>

        <div className="report-reasons" role="radiogroup" aria-label="Reason">
          {REASONS.map((option) => (
            <button
              key={option.id}
              role="radio"
              aria-checked={reason === option.id}
              className="report-chip"
              data-active={reason === option.id}
              onClick={() => setReason(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="report-field">
          <span>What is wrong? (optional)</span>
          <textarea
            value={note}
            maxLength={2000}
            rows={3}
            onChange={(event) => setNote(event.target.value)}
            placeholder="It helps to say what the reply did."
          />
        </label>

        <label className="report-history">
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={(event) => setIncludeHistory(event.target.checked)}
          />
          <span>
            <strong>Include the whole conversation</strong>
            <em>
              {history.length} message{history.length === 1 ? "" : "s"} · helps
              us see what led to this reply
            </em>
          </span>
        </label>

        {error ? <p className="update-error">{error}</p> : null}

        <div className="report-actions">
          <button className="btn" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void send()}
            disabled={sending}
          >
            {sending ? "Sending…" : "Send report"}
          </button>
        </div>
      </div>
    </div>
  );
}
