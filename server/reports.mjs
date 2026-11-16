import { Router, json } from "express";

import { approvedRequest } from "./tokens.mjs";

/**
 * Reporting inappropriate AI output.
 *
 * Microsoft Store policy 11.16 requires apps with live generative AI content to
 * give users a way to report it. The desktop app sends the reported reply, the
 * reason, an optional note and — only when the user ticks the box — the whole
 * conversation. Reports are stored next to the account and are visible through
 * scripts/ai-reports.sh.
 */
export const REPORT_REASONS = new Set([
  "harmful",
  "sexual",
  "violence",
  "hate",
  "other",
]);

const MAX_REASON = 20;
const MAX_ID = 120;
const MAX_NOTE = 2_000;
const MAX_MESSAGE = 200_000;
const MAX_TRANSCRIPT_MESSAGES = 400;
const MAX_TRANSCRIPT_CHARS = 400_000;
const MAX_REPORTS_PER_HOUR = 10;

function text(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function refuse(res, account) {
  return res.status(account.status).json({
    error: {
      message: account.message,
      type: "invalid_request_error",
      code: account.code,
    },
  });
}

export function createReportsRouter({ db, auth }) {
  const router = Router();
  // A full conversation can be large; the endpoint caps it below.
  router.use(json({ limit: "1mb" }));

  router.post("/", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const account = approvedRequest({ req, db, auth });
    if (!account.row) return refuse(res, account);

    const body = req.body ?? {};
    const reason = text(body.reason, MAX_REASON);
    if (!REPORT_REASONS.has(reason)) {
      return res.status(400).json({ error: "invalid_reason" });
    }

    const content = text(body.content, MAX_MESSAGE);
    if (!content.trim()) {
      return res.status(400).json({ error: "missing_content" });
    }

    // The transcript is opt-in: null means "just the reported reply".
    let transcript = null;
    if (Array.isArray(body.transcript)) {
      const messages = body.transcript
        .filter(
          (message) =>
            message &&
            (message.role === "user" || message.role === "assistant") &&
            typeof message.content === "string" &&
            message.content.trim(),
        )
        .slice(-MAX_TRANSCRIPT_MESSAGES)
        .map((message) => ({
          role: message.role,
          content: message.content.slice(0, MAX_MESSAGE),
        }));
      const serialized = JSON.stringify(messages);
      if (serialized.length > MAX_TRANSCRIPT_CHARS) {
        return res.status(413).json({ error: "transcript_too_large" });
      }
      transcript = serialized;
    }

    const recent = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ai_reports
         WHERE google_subject = ?
           AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')`,
      )
      .get(account.row.google_subject).count;
    if (Number(recent) >= MAX_REPORTS_PER_HOUR) {
      return res.status(429).json({ error: "too_many_reports" });
    }

    db.prepare(
      `INSERT INTO ai_reports
         (google_subject, chat_id, message_id, reason, note, content,
          transcript, app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      account.row.google_subject,
      text(body.chatId, MAX_ID),
      text(body.messageId, MAX_ID),
      reason,
      text(body.note, MAX_NOTE) || null,
      content,
      transcript,
      text(body.appVersion, 40) || null,
    );

    res.status(201).json({ ok: true });
  });

  return router;
}
