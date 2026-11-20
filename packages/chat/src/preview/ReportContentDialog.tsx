import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Flag, X } from "lucide-react";

import { REPORT_REASONS, type ReportReason } from "../ReportDialog";
import "../report.css";
import type { PreviewTarget } from "./types";

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The report could not be sent.";
}

/**
 * Reporting something a *person* wrote, seen through a preview.
 *
 * A task's comments and a document are other people's words, so App Store 1.2
 * ("user-generated content") and Google Play's UGC policy ask for a flag that
 * does not depend on the model having produced anything. It shares the AI
 * report's transport and its reasons; what differs is that there is no
 * conversation to attach — the excerpt is the evidence.
 */
export function ReportContentDialog({
  target,
  onClose,
  submit,
}: {
  target: PreviewTarget;
  onClose: () => void;
  submit: (input: { reason: ReportReason; note: string | null }) => Promise<void>;
}) {
  const [reason, setReason] = useState<ReportReason>("other");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await submit({ reason, note: note.trim() || null });
      onClose();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSending(false);
    }
  };

  return createPortal(
    <div className="report-backdrop" onMouseDown={onClose}>
      <div
        className="report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-content-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="report-head">
          <span className="report-icon" aria-hidden="true">
            <Flag strokeWidth={1.8} />
          </span>
          <div className="report-title-copy">
            <h2 id="report-content-title">Report this {target.kind}</h2>
            <p>
              Reports go to Hook for review. The {target.kind} —{" "}
              <strong>{target.title}</strong> — is included, so do not report
              something that has to stay private.
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X strokeWidth={2} />
          </button>
        </div>

        <div className="report-reasons" role="radiogroup" aria-label="Reason">
          {REPORT_REASONS.map((option) => (
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
            placeholder="Who wrote it, and where it appears."
          />
        </label>

        {error ? <p className="report-error">{error}</p> : null}

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
    </div>,
    document.body,
  );
}
