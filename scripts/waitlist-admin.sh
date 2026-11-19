#!/usr/bin/env bash
#
# Approve, revoke, and inspect Hook accounts and model usage.
#
#   ./scripts/waitlist-admin.sh --list
#   ./scripts/waitlist-admin.sh --approve someone@example.com
#   ./scripts/waitlist-admin.sh --revoke someone@example.com
#   ./scripts/waitlist-admin.sh --delete someone@example.com
#   ./scripts/waitlist-admin.sh --usage
#   ./scripts/waitlist-admin.sh --usage-chats
#   ./scripts/waitlist-admin.sh --usage-agents
#
# The database is read/written inside the hook-waitlist container, so nothing
# has to be installed on the VPS or on your machine. Revoking takes effect on
# the account's next API request: the proxy re-checks status every time.
#
# The database stores UTC; every timestamp below is printed in Israel time
# (Asia/Jerusalem, DST included).
#
#   DEPLOY_HOST=root@1.2.3.4 ./scripts/waitlist-admin.sh --list
#
set -euo pipefail

HOST="${DEPLOY_HOST:-root@167.233.58.139}"
CONTAINER="${DEPLOY_CONTAINER:-hook-waitlist}"
COMMAND="${1:---list}"
ARG="${2:-}"

if [ "$COMMAND" = "--help" ] || [ "$COMMAND" = "-h" ]; then
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
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

const write =
  command === "--approve" || command === "--revoke" || command === "--delete";
const db = new DatabaseSync(dbPath, { readOnly: !write });
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");

// The database writes UTC (strftime ... 'now' with a trailing Z). Show it in
// Israel time so an admin reading the table does not have to add the offset.
const stamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const utc = (value) =>
  value ? stamp.format(new Date(value)).replace(",", "") : "—";
const num = (value) => Intl.NumberFormat("en-US").format(Number(value) || 0);
const rate = (hit, miss) => {
  const total = Number(hit) + Number(miss);
  return total > 0 ? `${((Number(hit) / total) * 100).toFixed(1)}%` : "—";
};
const totalsLine = (rows) => {
  const total = rows.reduce(
    (acc, row) => {
      acc.requests += Number(row.requests) || 0;
      acc.input += Number(row.input_tokens) || 0;
      acc.output += Number(row.output_tokens) || 0;
      acc.hit += Number(row.cache_hits) || 0;
      acc.miss += Number(row.cache_misses) || 0;
      return acc;
    },
    { requests: 0, input: 0, output: 0, hit: 0, miss: 0 },
  );
  return `TOTAL: ${num(total.requests)} requests · ${num(total.input)} input · ${num(total.output)} output · ${rate(total.hit, total.miss)} cache hit`;
};
const table = (headers, rows) => {
  if (!rows.length) {
    console.log("Nothing yet.");
    return;
  }
  const body = rows.map((row) => row.map((value) => String(value)));
  const width = headers.map((header, i) =>
    Math.max(header.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => cell.padEnd(width[i])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(width.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
};

function findAccount() {
  return db
    .prepare(
      `SELECT google_subject, email, waitlist_status, approved_at, revoked_at
       FROM waitlist_signups
       WHERE lower(email) = lower(?) OR google_subject = ?
       LIMIT 1`,
    )
    .get(argument, argument);
}

function requireAccount() {
  if (!argument) {
    console.error("Missing an email address or Google subject.");
    process.exit(2);
  }
  const account = findAccount();
  if (!account) {
    console.error(`No account matches ${argument}.`);
    process.exit(3);
  }
  return account;
}

if (command === "--approve") {
  const account = requireAccount();
  db.prepare(
    `UPDATE waitlist_signups SET
       waitlist_status = 'approved',
       approved_at = COALESCE(approved_at, ${NOW}),
       revoked_at = NULL
     WHERE google_subject = ?`,
  ).run(account.google_subject);
  // Deliberately do not un-revoke old tokens: a token revoked by sign-out or
  // by an earlier revocation requires a fresh sign-in.
  console.log(`approved ${account.email} (${account.google_subject})`);
  console.log("The desktop app can now sign in; existing sessions work again.");
} else if (command === "--revoke") {
  const account = requireAccount();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE waitlist_signups SET
         waitlist_status = 'revoked',
         revoked_at = ${NOW}
       WHERE google_subject = ?`,
    ).run(account.google_subject);
    const revoked = db
      .prepare(
        `UPDATE api_tokens SET revoked_at = ${NOW}
         WHERE google_subject = ? AND revoked_at IS NULL`,
      )
      .run(account.google_subject);
    db.exec("COMMIT");
    console.log(
      `revoked ${account.email} (${account.google_subject}); ${revoked.changes} token(s) invalidated`,
    );
    console.log("The next request from that account returns 403.");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} else if (command === "--delete") {
  const account = requireAccount();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM usage_events WHERE google_subject = ?").run(
      account.google_subject,
    );
    db.prepare("DELETE FROM desktop_logins WHERE google_subject = ?").run(
      account.google_subject,
    );
    db.prepare("DELETE FROM onboarding_events WHERE google_subject = ?").run(
      account.google_subject,
    );
    db.prepare("DELETE FROM api_tokens WHERE google_subject = ?").run(
      account.google_subject,
    );
    db.prepare("DELETE FROM waitlist_signups WHERE google_subject = ?").run(
      account.google_subject,
    );
    db.exec("COMMIT");
    console.log(`deleted ${account.email} (${account.google_subject}) and all usage metadata`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} else if (command === "--usage") {
  const rows = db
    .prepare(
      `SELECT s.email, s.waitlist_status AS status,
              COUNT(u.id) AS requests,
              COALESCE(SUM(u.prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_hit_tokens), 0) AS cache_hits,
              COALESCE(SUM(u.cache_miss_tokens), 0) AS cache_misses,
              MAX(u.created_at) AS last_request
       FROM waitlist_signups s
       LEFT JOIN usage_events u ON u.google_subject = s.google_subject
       GROUP BY s.google_subject
       ORDER BY input_tokens DESC, s.joined_at DESC`,
    )
    .all();
  table(
    ["EMAIL", "STATUS", "REQUESTS", "INPUT", "OUTPUT", "CACHE HIT", "LAST REQUEST (IL)"],
    rows.map((row) => [
      row.email,
      row.status,
      num(row.requests),
      num(row.input_tokens),
      num(row.output_tokens),
      rate(row.cache_hits, row.cache_misses),
      utc(row.last_request),
    ]),
  );
  console.log(`
${totalsLine(rows)}`);
} else if (command === "--usage-chats") {
  const rows = db
    .prepare(
      `SELECT s.email, u.chat_id, COUNT(u.id) AS requests,
              COALESCE(SUM(u.prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_hit_tokens), 0) AS cache_hits,
              COALESCE(SUM(u.cache_miss_tokens), 0) AS cache_misses,
              MIN(u.created_at) AS first_seen, MAX(u.created_at) AS last_seen
       FROM usage_events u
       JOIN waitlist_signups s USING (google_subject)
       WHERE u.chat_id IS NOT NULL
       GROUP BY u.google_subject, u.chat_id
       ORDER BY last_seen DESC`,
    )
    .all();
  table(
    ["EMAIL", "CHAT", "REQUESTS", "INPUT", "OUTPUT", "CACHE HIT", "LAST SEEN (IL)"],
    rows.map((row) => [
      row.email,
      row.chat_id,
      num(row.requests),
      num(row.input_tokens),
      num(row.output_tokens),
      rate(row.cache_hits, row.cache_misses),
      utc(row.last_seen),
    ]),
  );
  console.log(`
${totalsLine(rows)}`);
} else if (command === "--usage-agents") {
  const rows = db
    .prepare(
      `SELECT s.email, u.agent_id, u.chat_id, COUNT(u.id) AS requests,
              COALESCE(SUM(u.prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_hit_tokens), 0) AS cache_hits,
              COALESCE(SUM(u.cache_miss_tokens), 0) AS cache_misses,
              MIN(u.created_at) AS first_seen, MAX(u.created_at) AS last_seen
       FROM usage_events u
       JOIN waitlist_signups s USING (google_subject)
       WHERE u.agent_id IS NOT NULL
       GROUP BY u.google_subject, u.agent_id
       ORDER BY last_seen DESC`,
    )
    .all();
  table(
    ["EMAIL", "AGENT", "CHAT", "REQUESTS", "INPUT", "OUTPUT", "CACHE HIT", "LAST SEEN (IL)"],
    rows.map((row) => [
      row.email,
      row.agent_id,
      row.chat_id || "—",
      num(row.requests),
      num(row.input_tokens),
      num(row.output_tokens),
      rate(row.cache_hits, row.cache_misses),
      utc(row.last_seen),
    ]),
  );
  console.log(`
${totalsLine(rows)}`);
} else {
  // Default and --list: accounts first, with a compact usage roll-up.
  const rows = db
    .prepare(
      `SELECT s.email, s.waitlist_status AS status, s.joined_at,
              s.approved_at, s.revoked_at,
              COUNT(u.id) AS requests,
              COALESCE(SUM(u.prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_hit_tokens), 0) AS cache_hits,
              COALESCE(SUM(u.cache_miss_tokens), 0) AS cache_misses
       FROM waitlist_signups s
       LEFT JOIN usage_events u ON u.google_subject = s.google_subject
       GROUP BY s.google_subject
       ORDER BY
         CASE s.waitlist_status WHEN 'approved' THEN 0 WHEN 'waitlisted' THEN 1 ELSE 2 END,
         s.joined_at DESC`,
    )
    .all();
  table(
    ["EMAIL", "STATUS", "JOINED (IL)", "APPROVED (IL)", "REQUESTS", "INPUT", "OUTPUT", "CACHE HIT"],
    rows.map((row) => [
      row.email,
      row.status,
      utc(row.joined_at),
      utc(row.approved_at),
      num(row.requests),
      num(row.input_tokens),
      num(row.output_tokens),
      rate(row.cache_hits, row.cache_misses),
    ]),
  );
  const counts = rows.reduce(
    (acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    },
    {},
  );
  console.log(
    `\n${rows.length} account(s): ${Object.entries(counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ") || "none"}`,
  );
}

db.close();
JS
