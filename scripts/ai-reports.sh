#!/usr/bin/env bash
#
# Review in-app reports of inappropriate AI output (Microsoft Store policy 11.16).
#
#   ./scripts/ai-reports.sh --list
#   ./scripts/ai-reports.sh --show 12
#   ./scripts/ai-reports.sh --resolve 12
#
# Reports live in the same SQLite database as the waitlist. The database is read
# inside the hook-waitlist container, so nothing has to be installed locally.
# Resolving a report records when it was handled; content is not deleted — use
# --show to inspect it and act on it.
#
set -euo pipefail

HOST="${DEPLOY_HOST:-root@167.233.58.139}"
CONTAINER="${DEPLOY_CONTAINER:-hook-waitlist}"
COMMAND="${1:---list}"
ARG="${2:-}"

if [ "$COMMAND" = "--help" ] || [ "$COMMAND" = "-h" ]; then
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
SSH_KEY="${DEPLOY_KEY:-$HOME/.ssh/hetzner_root}"
if [ -f "$SSH_KEY" ]; then SSH_OPTS+=(-i "$SSH_KEY"); fi

if [ -z "${SSH_BIN:-}" ]; then
  for candidate in /c/Windows/System32/OpenSSH/ssh.exe ssh; do
    if command -v "$candidate" >/dev/null 2>&1; then SSH_BIN="$candidate"; break; fi
  done
fi

"$SSH_BIN" "${SSH_OPTS[@]}" "$HOST" \
  "docker exec -i '$CONTAINER' node --input-type=commonjs - '$COMMAND' '$ARG'" <<'JS'
const { DatabaseSync } = require("node:sqlite");
const command = process.argv[2] || "--list";
const argument = process.argv[3] || "";
const dbPath = process.env.WAITLIST_DB_PATH || "/data/signups.sqlite";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const write = command === "--resolve";

const db = new DatabaseSync(dbPath, { readOnly: !write });
db.exec("PRAGMA busy_timeout = 5000;");

const utc = (value) => (value ? value.replace("T", " ").slice(0, 16) : "—");
const oneLine = (value) => String(value || "").replace(/\s+/g, " ").trim();

if (command === "--list") {
  const rows = db
    .prepare(
      `SELECT r.id, r.created_at, r.status, r.reason, r.content, r.subject_kind,
              s.email, s.waitlist_status
       FROM ai_reports r
       JOIN waitlist_signups s ON s.google_subject = r.google_subject
       ORDER BY r.id DESC
       LIMIT 100`,
    )
    .all();
  if (!rows.length) {
    console.log("No AI reports.");
    process.exit(0);
  }
  for (const row of rows) {
    const kind = row.subject_kind === "content" ? "content " : "reply   ";
    console.log(
      `#${String(row.id).padEnd(5)} ${utc(row.created_at)}  ${row.status.padEnd(8)}  ${kind}  ${row.reason.padEnd(9)}  ${row.email} (${row.waitlist_status})  ${oneLine(row.content).slice(0, 90)}`,
    );
  }
  const open = db
    .prepare("SELECT COUNT(*) AS count FROM ai_reports WHERE status = 'open'")
    .get().count;
  console.log(`\n${open} open report(s).`);
} else if (command === "--show") {
  const id = Number(argument);
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Pass a numeric report id, for example: --show 12");
    process.exit(2);
  }
  const row = db
    .prepare(
      `SELECT r.*, s.email, s.waitlist_status
       FROM ai_reports r
       JOIN waitlist_signups s ON s.google_subject = r.google_subject
       WHERE r.id = ?`,
    )
    .get(id);
  if (!row) {
    console.error(`No report #${id}.`);
    process.exit(3);
  }
  console.log(`#${row.id}  ${utc(row.created_at)}  ${row.status}`);
  console.log(`account: ${row.email} (${row.waitlist_status})`);
  console.log(`chat: ${row.chat_id || "—"}  message: ${row.message_id || "—"}`);
  console.log(`reason: ${row.reason}  app: ${row.app_version || "—"}`);
  if (row.target) {
    // A report of something a person wrote: say which entity it came from, so
    // a reviewer does not go looking for a reply in the conversation.
    try {
      const target = JSON.parse(row.target);
      console.log(
        `target: ${target.kind}${target.projectId ? ` ${target.projectId}/` : " "}${target.id}  "${target.title}"`,
      );
    } catch {
      console.log(`target: ${row.target}`);
    }
  }
  console.log(`note: ${row.note || "—"}`);
  console.log("\n--- reported reply ---\n");
  console.log(row.content);
  if (row.transcript) {
    console.log("\n--- conversation (opt-in by the reporter) ---\n");
    for (const message of JSON.parse(row.transcript)) {
      console.log(`[${message.role}] ${message.content}\n`);
    }
  }
} else if (command === "--resolve") {
  const id = Number(argument);
  if (!Number.isInteger(id) || id <= 0) {
    console.error("Pass a numeric report id, for example: --resolve 12");
    process.exit(2);
  }
  const result = db
    .prepare(
      `UPDATE ai_reports SET status = 'resolved', resolved_at = ${NOW}
       WHERE id = ? AND status = 'open'`,
    )
    .run(id);
  if (result.changes === 0) {
    console.error(`Report #${id} does not exist or is already resolved.`);
    process.exit(3);
  }
  console.log(`report #${id} resolved`);
} else {
  console.error("usage: ./scripts/ai-reports.sh [--list | --show <id> | --resolve <id>]");
  process.exit(2);
}
JS
