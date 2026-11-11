#!/usr/bin/env bash
#
# Look at who joined the Hook waitlist.
#
#   ./scripts/waitlist-people.sh              # table, newest first
#   ./scripts/waitlist-people.sh --csv        # email,joined_at,google_subject
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
const rows = db
  .prepare("select email, joined_at, google_subject from waitlist_signups order by joined_at desc")
  .all();

if (format === "--count") {
  console.log(rows.length);
} else if (format === "--csv") {
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  console.log("email,joined_at,google_subject");
  for (const r of rows) console.log([r.email, r.joined_at, r.google_subject].map(esc).join(","));
} else {
  if (!rows.length) {
    console.log("No signups yet.");
  } else {
    const head = ["EMAIL", "JOINED (UTC)", "GOOGLE SUBJECT"];
    const body = rows.map((r) => [r.email, r.joined_at.replace("T", " ").slice(0, 19), r.google_subject]);
    const width = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
    const line = (cols) => cols.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd();
    console.log(line(head));
    console.log(width.map((w) => "-".repeat(w)).join("  "));
    for (const b of body) console.log(line(b));
    console.log(`\n${rows.length} signup${rows.length === 1 ? "" : "s"}`);
  }
}
JS
