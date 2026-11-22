/**
 * What an account is entitled to.
 *
 * One column decides it: `waitlist_signups.plan`, one of `free`, `plus` or
 * `pro`. Nothing else in the service branches on the product name, so assigning
 * a plan is a one-row update (see `scripts/waitlist-admin.sh --plan`).
 *
 * The waitlist is untouched: a row that has not been approved has a null plan
 * and cannot sign in. Approving it is what assigns one, and with no choice made
 * that plan is `free`. Free is the only plan with restrictions:
 *
 * - conversations, projects, memory and pictures are not synced to the cloud
 * - the model proxy serves 100 user messages per rolling 24 hours
 * - coding agents are refused (`surface: coding` on the proxy)
 *
 * A request that never reaches this service — a user's own endpoint configured
 * in the app — is not metered here, which is why the free limit lives in the
 * proxy and not in a table the app writes.
 */

export const FREE_MESSAGE_LIMIT = 100;
export const FREE_MESSAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The value stored for an account that has not been given a plan yet. */
export const DEFAULT_PLAN = "free";

export function planOf(row) {
  const plan = typeof row?.plan === "string" ? row.plan.trim().toLowerCase() : "";
  return plan || DEFAULT_PLAN;
}

export function isFreePlan(row) {
  return planOf(row) === "free";
}

/** The proxy surface a message belongs to. Only a chat message counts. */
export const COUNTED_SURFACE = "chat";

/* Same shape `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` writes: ISO-8601 with a
 * trailing Z, so string comparison is chronological. `datetime('now')` would
 * be `YYYY-MM-DD HH:MM:SS`, and `T` sorts after a space — comparing the two
 * formats would count the whole current day as inside every window. */
const WINDOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')";

/**
 * Distinct user messages in the last 24 hours.
 *
 * The desktop sends `X-Hook-Message-Id` with every request of a turn, so a
 * turn that calls tools (several model requests) counts once, and regenerating
 * or editing the same message does not buy a second slot.
 */
export function quotaUsed(db, subject) {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT message_id) AS used
         FROM usage_events
        WHERE google_subject = ?
          AND surface = ?
          AND message_id IS NOT NULL
          AND created_at >= ${WINDOW_SQL}`,
    )
    .get(subject, COUNTED_SURFACE);
  return Number(row?.used) || 0;
}

/**
 * When the oldest counted message falls out of the window. `null` when nothing
 * is counted, which also means "nothing to wait for".
 */
export function quotaResetAt(db, subject) {
  const row = db
    .prepare(
      `SELECT MIN(created_at) AS oldest FROM (
         SELECT created_at
           FROM usage_events
          WHERE google_subject = ?
            AND surface = ?
            AND message_id IS NOT NULL
            AND created_at >= ${WINDOW_SQL}
          GROUP BY message_id
       )`,
    )
    .get(subject, COUNTED_SURFACE);
  if (!row?.oldest) return null;
  const oldest = Date.parse(row.oldest);
  if (!Number.isFinite(oldest)) return null;
  return new Date(oldest + FREE_MESSAGE_WINDOW_MS).toISOString();
}

/**
 * What the window looks like to the app. A paid account answers `null`: there
 * is no quota to draw, and the app should not invent one.
 */
export function quotaView(db, row) {
  if (!isFreePlan(row)) return null;
  const used = quotaUsed(db, row.google_subject);
  return {
    limit: FREE_MESSAGE_LIMIT,
    used,
    remaining: Math.max(0, FREE_MESSAGE_LIMIT - used),
    resetAt: quotaResetAt(db, row.google_subject),
  };
}

/**
 * Why remote control is unavailable, or null when the account may use it.
 *
 * Remote control is account data and server capacity, so it is paid-only —
 * including for a free account that brought its own model endpoint. It also
 * needs cloud sync on: the other device reads the same conversation, and the
 * switch that keeps conversations off the account keeps them off the relay
 * too.
 */
export function remoteRefusal(row) {
  if (isFreePlan(row)) {
    return {
      code: "remote_not_included",
      message:
        "Running work on your other machines is part of a paid plan.",
    };
  }
  if (Number(row.cloud_sync) === 0) {
    return {
      code: "sync_disabled",
      message:
        "Turn on cloud sync to use your other machines. Settings, under Advanced.",
    };
  }
  return null;
}

/** Why sync is unavailable, or null when the account may sync. */
export function syncRefusal(row) {
  if (isFreePlan(row)) {
    return {
      code: "sync_not_included",
      message:
        "Cloud sync is part of a paid plan. Your chats and projects stay on this computer.",
    };
  }
  if (Number(row.cloud_sync) === 0) {
    return {
      code: "sync_disabled",
      message:
        "Cloud sync is turned off for this account. Turn it on in Settings, under Advanced.",
    };
  }
  return null;
}
