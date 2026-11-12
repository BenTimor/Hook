#!/usr/bin/env bash
#
# Look at who joined the Hook waitlist.
#
#   ./scripts/waitlist-people.sh              # table, newest first
#   ./scripts/waitlist-people.sh --csv        # profiles, choices, prices, progress
#   ./scripts/waitlist-people.sh --events     # onboarding action history as CSV
#   ./scripts/waitlist-people.sh --count      # just the number
#
# Reads /data/signups.sqlite inside the hook-waitlist container, so it works
# from anywhere without Node or sqlite3 on your machine or on the VPS.
#
#   DEPLOY_HOST=root@1.2.3.4 ./scripts/waitlist-people.sh
#
set -euo pipefail

HOST="${DEPLOY_HOST:-root@167.233.58.139}"
CONTAINER="${DEPLOY_CONTAINER:-hook-waitlist}"
FORMAT="${1:-table}"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
SSH_KEY="${DEPLOY_KEY:-$HOME/.ssh/hetzner_root}"
if [ -f "$SSH_KEY" ]; then SSH_OPTS+=(-i "$SSH_KEY"); fi

if [ -z "${SSH_BIN:-}" ]; then
  for candidate in /c/Windows/System32/OpenSSH/ssh.exe ssh; do
    if command -v "$candidate" >/dev/null 2>&1; then SSH_BIN="$candidate"; break; fi
  done
fi

"$SSH_BIN" "${SSH_OPTS[@]}" "$HOST" \
  "docker exec -i '$CONTAINER' node --input-type=commonjs - '$FORMAT'" <<'JS'
const { DatabaseSync } = require("node:sqlite");
const format = process.argv[2] || "table";

const db = new DatabaseSync(process.env.WAITLIST_DB_PATH || "/data/signups.sqlite", { readOnly: true });
const columns = new Set(db.prepare("PRAGMA table_info(waitlist_signups)").all().map(c => c.name));
const optional = ["interests", "plan_preference", "plan_price_cents", "plan_currency", "plan_period", "onboarding_step", "onboarding_started_at", "onboarding_updated_at", "onboarding_completed_at"];
const rows = db
  .prepare(`SELECT email, joined_at, google_subject, ${optional.map(c => columns.has(c) ? c : `NULL AS ${c}`).join(", ")} FROM waitlist_signups ORDER BY joined_at DESC`)
  .all();
const csv = (entries, headers) => {
  const esc = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  console.log(headers.map(esc).join(","));
  for (const entry of entries) console.log(headers.map(h => esc(entry[h])).join(","));
};

if (format === "--count") {
  console.log(rows.length);
} else if (format === "--events") {
  const headers = ["email", "google_subject", "recorded_at", "event_type", "details", "applied", "client_id", "sequence", "event_id"];
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_events'").get();
  const events = exists ? db.prepare(`SELECT s.email, e.* FROM onboarding_events e JOIN waitlist_signups s USING (google_subject) ORDER BY e.recorded_at DESC, e.rowid DESC`).all() : [];
  csv(events, headers);
} else if (format === "--csv") {
  csv(rows, ["email", "joined_at", "google_subject", ...optional]);
} else {
  if (!rows.length) {
    console.log("No signups yet.");
  } else {
    const head = ["EMAIL", "JOINED (UTC)", "INTERESTS", "PLAN", "PRICE", "STEP", "COMPLETED (UTC)"];
    const utc = (value) => value ? value.replace("T", " ").slice(0, 19) : "—";
    const body = rows.map((r) => [r.email, utc(r.joined_at), JSON.parse(r.interests || "[]").join(", ") || "—", r.plan_preference || "—", r.plan_price_cents == null ? "—" : `${(r.plan_price_cents / 100).toFixed(2)} ${r.plan_currency}${r.plan_period}`, r.onboarding_step || "—", utc(r.onboarding_completed_at)]);
    const width = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
    const line = (cols) => cols.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd();
    console.log(line(head));
    console.log(width.map((w) => "-".repeat(w)).join("  "));
    for (const b of body) console.log(line(b));
    console.log(`\n${rows.length} signup${rows.length === 1 ? "" : "s"}`);
  }
}
db.close();
JS
