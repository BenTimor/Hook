#!/usr/bin/env bash
#
# Approve, revoke, assign a plan and inspect Hook accounts and model usage.
#
#   ./scripts/waitlist-admin.sh --list
#   ./scripts/waitlist-admin.sh --approve someone@example.com
#   ./scripts/waitlist-admin.sh --revoke someone@example.com
#   ./scripts/waitlist-admin.sh --delete someone@example.com
#   ./scripts/waitlist-admin.sh --plan someone@example.com pro
#   ./scripts/waitlist-admin.sh --sync someone@example.com off
#   ./scripts/waitlist-admin.sh --plans
#   ./scripts/waitlist-admin.sh --events
#   ./scripts/waitlist-admin.sh --usage
#   ./scripts/waitlist-admin.sh --usage-plans
#   ./scripts/waitlist-admin.sh --usage-chats
#   ./scripts/waitlist-admin.sh --usage-agents
#
# The waitlist is unchanged: nobody can sign in until --approve. Approving an
# account without choosing a plan makes it `free`; a waitlisted row has no plan
# at all. Plans are `free`, `plus` or `pro`. A free account does not sync
# conversations to the cloud, is limited to 100 messages per rolling 24 hours
# through Hook's model service, and cannot start coding agents. A personal model
# provider set in the app bypasses the last two.
#
# `--sync` sets the account-level cloud-sync switch (on|off). It is refused for
# a free account, which never syncs.
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
EXTRA="${3:-}"

if [ "$COMMAND" = "--help" ] || [ "$COMMAND" = "-h" ]; then
  sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
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
  "docker exec -i '$CONTAINER' node --input-type=commonjs - '$COMMAND' '$ARG' '$EXTRA'" <<'JS'
const { DatabaseSync } = require("node:sqlite");
const command = process.argv[2] || "--list";
const argument = process.argv[3] || "";
const extra = String(process.argv[4] || "").toLowerCase();
const dbPath = process.env.WAITLIST_DB_PATH || "/data/signups.sqlite";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const PLANS = new Set(["free", "plus", "pro"]);

const write =
  command === "--approve" ||
  command === "--revoke" ||
  command === "--delete" ||
  command === "--plan" ||
  command === "--sync";
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
      `SELECT google_subject, email, waitlist_status, plan, cloud_sync,
              approved_at, revoked_at
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
  console.log(
    `plan: ${account.plan || "free"} (assign another with --plan ${account.email} plus|pro)`,
  );
  console.log("The desktop app can now sign in; existing sessions work again.");
} else if (command === "--plan") {
  const account = requireAccount();
  if (!PLANS.has(extra)) {
    console.error("Usage: --plan <email> <free|plus|pro>");
    process.exit(2);
  }
  db.prepare("UPDATE waitlist_signups SET plan = ? WHERE google_subject = ?").run(
    extra,
    account.google_subject,
  );
  console.log(`plan for ${account.email} (${account.google_subject}): ${extra}`);
  if (account.waitlist_status !== "approved") {
    console.log(
      `note: ${account.email} is still on the waitlist (${account.waitlist_status}); the app cannot sign in until --approve.`,
    );
  }
  console.log(
    extra === "free"
      ? "No cloud sync, 100 messages per rolling 24 hours, no coding agents unless the user sets their own model provider."
      : "Cloud sync is available; the account's switch is " +
        (Number(account.cloud_sync) === 0 ? "off." : "on.") +
        " The app learns the new plan on its next account check.",
  );
} else if (command === "--sync") {
  const account = requireAccount();
  if (extra !== "on" && extra !== "off") {
    console.error("Usage: --sync <email> <on|off>");
    process.exit(2);
  }
  if ((account.plan || "free") === "free") {
    console.error(
      `${account.email} is on the free plan: cloud sync is not included.`,
    );
    process.exit(4);
  }
  db.prepare(
    "UPDATE waitlist_signups SET cloud_sync = ? WHERE google_subject = ?",
  ).run(extra === "on" ? 1 : 0, account.google_subject);
  console.log(
    `cloud sync for ${account.email} (${account.google_subject}): ${extra}`,
  );
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
    db.prepare("DELETE FROM client_events WHERE google_subject = ?").run(
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
} else if (command === "--plans") {
  // Only approved accounts have a plan; everyone else is still outside.
  const rows = db
    .prepare(
      `SELECT COALESCE(plan, 'free') AS plan,
              SUM(CASE WHEN cloud_sync = 0 THEN 1 ELSE 0 END) AS sync_off,
              COUNT(*) AS accounts
       FROM waitlist_signups
       WHERE waitlist_status = 'approved'
       GROUP BY COALESCE(plan, 'free')
       ORDER BY accounts DESC`,
    )
    .all();
  table(
    ["PLAN", "ACCOUNTS", "CLOUD SYNC OFF"],
    rows.map((row) => [row.plan, num(row.accounts), num(row.sync_off)]),
  );
  const waiting = db
    .prepare(
      "SELECT COUNT(*) AS total FROM waitlist_signups WHERE waitlist_status != 'approved'",
    )
    .get().total;
  console.log(
    `
${num(waiting)} account(s) are not approved and have no plan yet.`,
  );
} else if (command === "--events") {
  // What the app did that the model proxy never sees: personal endpoints,
  // the free limit, and the cloud-sync switch. No text, endpoint or key is
  // stored, so there is nothing else to print.
  const counts = db
    .prepare(
      `SELECT kind, plan, COUNT(*) AS events,
              COUNT(DISTINCT google_subject) AS people,
              MAX(created_at) AS last_seen
       FROM client_events
       WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
       GROUP BY kind, plan
       ORDER BY events DESC`,
    )
    .all();
  table(
    ["EVENT", "PLAN", "EVENTS", "PEOPLE", "LAST SEEN (IL)"],
    counts.map((row) => [
      row.kind,
      row.plan,
      num(row.events),
      num(row.people),
      utc(row.last_seen),
    ]),
  );
  const recent = db
    .prepare(
      `SELECT s.email, e.kind, e.plan, e.product, e.app_version, e.created_at
       FROM client_events e
       JOIN waitlist_signups s USING (google_subject)
       ORDER BY e.created_at DESC
       LIMIT 20`,
    )
    .all();
  console.log("\nMost recent:");
  table(
    ["EMAIL", "EVENT", "PLAN", "PRODUCT", "VERSION", "WHEN (IL)"],
    recent.map((row) => [
      row.email,
      row.kind,
      row.plan,
      row.product,
      row.app_version || "—",
      utc(row.created_at),
    ]),
  );
} else if (command === "--usage") {
  const rows = db
    .prepare(
      `SELECT s.email, s.waitlist_status AS status, COALESCE(s.plan, 'free') AS plan,
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
    ["EMAIL", "STATUS", "PLAN", "REQUESTS", "INPUT", "OUTPUT", "CACHE HIT", "LAST REQUEST (IL)"],
    rows.map((row) => [
      row.email,
      row.status,
      row.plan,
      num(row.requests),
      num(row.input_tokens),
      num(row.output_tokens),
      rate(row.cache_hits, row.cache_misses),
      utc(row.last_request),
    ]),
  );
  console.log(`
${totalsLine(rows)}`);
} else if (command === "--usage-plans") {
  // The plan stored on each request, not the account's plan today: a change of
  // plan must not relabel what was already served.
  const rows = db
    .prepare(
      `SELECT COALESCE(plan, 'free') AS plan,
              COUNT(*) AS requests,
              COUNT(DISTINCT google_subject) AS accounts,
              COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_hit_tokens), 0) AS cache_hits,
              COALESCE(SUM(cache_miss_tokens), 0) AS cache_misses,
              MAX(created_at) AS last_request
       FROM usage_events
       GROUP BY COALESCE(plan, 'free')
       ORDER BY requests DESC`,
    )
    .all();
  table(
    ["PLAN", "REQUESTS", "ACCOUNTS", "INPUT", "OUTPUT", "CACHE HIT", "LAST REQUEST (IL)"],
    rows.map((row) => [
      row.plan,
      num(row.requests),
      num(row.accounts),
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
      `SELECT s.email, s.waitlist_status AS status, COALESCE(s.plan, 'free') AS plan,
              s.cloud_sync, s.joined_at,
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
    ["EMAIL", "STATUS", "PLAN", "SYNC", "JOINED (IL)", "APPROVED (IL)", "REQUESTS", "INPUT", "OUTPUT", "CACHE HIT"],
    rows.map((row) => [
      row.email,
      row.status,
      row.plan ?? "—",
      Number(row.cloud_sync) === 0 ? "off" : "on",
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
