import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Flag, X } from "lucide-react";

import type { ChatMessage } from "./types";
import "./report.css";

export type ReportReason = "harmful" | "sexual" | "violence" | "hate" | "other";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ReportInput {
  reason: ReportReason;
  note: string | null;
  /** The conversation, only when the person opted in. */
  transcript: TranscriptMessage[] | null;
}

const REASONS: { id: ReportReason; label: string }[] = [
  { id: "harmful", label: "Harmful or dangerous" },
  { id: "sexual", label: "Sexual content" },
  { id: "violence", label: "Violence" },
  { id: "hate", label: "Hate or harassment" },
  { id: "other", label: "Something else" },
];

/** The reason list every report uses, AI output or a person's words. */
export const REPORT_REASONS = REASONS;

const MAX_TRANSCRIPT_CHARS = 300_000;
const MAX_TRANSCRIPT_MESSAGES = 300;

/**
 * The conversation to attach when the person opts in. Built from the end so a
 * very long chat still keeps the messages around the reported reply.
 */
function conversation(messages: ChatMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.hidden) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!message.content.trim()) continue;
    out.unshift({ role: message.role as "user" | "assistant", content: message.content });
    chars += message.content.length;
    if (chars >= MAX_TRANSCRIPT_CHARS || out.length >= MAX_TRANSCRIPT_MESSAGES) break;
  }
  return out;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The report could not be sent.";
}

/**
 * Reporting a reply (Store policy 11.16, and the decent thing to do anyway).
 *
 * It is presentation only: the product supplies `submit`, because only it knows
 * whether a report is an IPC call, a fetch or something else. The chat window
 * and a docked panel show the same dialog.
 */
export function ReportDialog({
  messages,
  onClose,
  submit,
}: {
  messages: ChatMessage[];
  onClose: () => void;
  submit: (input: ReportInput) => Promise<void>;
}) {
  const [reason, setReason] = useState<ReportReason>("other");
  const [note, setNote] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = conversation(messages);
  const transcript = includeHistory ? history : null;

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
      await submit({ reason, note: note.trim() || null, transcript });
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSending(false);
    }
  };

  // Portalled: a dock with `backdrop-filter` is a containing block for fixed
  // children, which would trap the dialog inside a 380px column.
  return createPortal(
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

        {error ? <p className="report-error">{error}</p> : null}

        <div className="report-actions">
          <button className="btn" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void send()} disabled={sending}>
            {sending ? "Sending…" : "Send report"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
