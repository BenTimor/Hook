import { createHash } from "node:crypto";

export function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

function header(req, name) {
  if (typeof req.get === "function") return req.get(name);
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** `Authorization: Bearer <opaque token>` or null. */
export function bearerToken(req) {
  const headerValue = header(req, "authorization");
  if (!headerValue) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

/**
 * Git cannot send a bearer header without a little help, so it may also use
 * HTTP Basic. The password (or the username when the password is empty) is
 * the opaque token; the username is ignored.
 */
function basicToken(req) {
  const headerValue = header(req, "authorization");
  if (!headerValue) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(headerValue.trim());
  if (!match) return null;
  let raw = "";
  try {
    raw = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = raw.indexOf(":");
  const password = separator >= 0 ? raw.slice(separator + 1) : raw;
  const token = password || raw;
  return /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null;
}

/** The opaque token on a request, from either auth scheme. */
export function requestToken(req) {
  return bearerToken(req) ?? basicToken(req);
}

/**
 * A per-install identifier the desktop sends on sync and token requests. It is
 * not a secret; it lets one install rotate its own git token without touching
 * other computers signed in to the same account.
 */
export function deviceId(req) {
  const value = header(req, "x-hook-device") ?? "";
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

/**
 * Resolve a bearer token to an approved waitlist account.
 *
 * Returns `{ row }` on success, or `{ status, code, message }` describing why
 * the request must be refused. Approval is part of the query, not a cached
 * claim, so revoking someone from the admin script stops their next request.
 */
export function apiUser(db, req, scope = "app") {
  const token = requestToken(req);
  if (!token) {
    return {
      status: 401,
      code: "missing_token",
      message: "Sign in to Hook to use this endpoint.",
    };
  }
  const row = db
    .prepare(
      `SELECT s.*, t.token_hash, t.revoked_at AS token_revoked_at,
              t.device_id AS token_device_id
       FROM api_tokens t
       JOIN waitlist_signups s ON s.google_subject = t.google_subject
       WHERE t.token_hash = ? AND t.scope = ?`,
    )
    .get(hashToken(token), scope);
  if (!row) {
    return {
      status: 401,
      code: "invalid_token",
      message: "This Hook session is no longer valid. Sign in again.",
    };
  }
  if (row.token_revoked_at) {
    return {
      status: 401,
      code: "revoked_token",
      message: "This Hook session was signed out. Sign in again.",
    };
  }
  if (row.waitlist_status !== "approved") {
    return {
      status: 403,
      code: "not_approved",
      message:
        "Hook is not enabled for this account. Contact us if you think this is a mistake.",
    };
  }
  return { row };
}

/** The approved account behind a git request. Git tokens cannot be used anywhere else. */
export function gitUser(db, req) {
  return apiUser(db, req, "git");
}

/** Express-friendly wrapper: sends the refusal and returns null. */
export function requireApiUser(db, req, res, scope = "app") {
  const result = apiUser(db, req, scope);
  if (!result.row) {
    res.status(result.status).json({
      error: {
        message: result.message,
        type: "invalid_request_error",
        code: result.code,
      },
    });
    return null;
  }
  // A cheap touch so the admin view can show when a token was last used.
  db.prepare(
    "UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE token_hash = ?",
  ).run(result.row.token_hash);
  return result.row;
}

/** OpenAI-shaped error body, used by the proxy for every failure path. */
export function apiError(res, status, message, code = "proxy_error") {
  res.status(status).json({
    error: { message, type: "invalid_request_error", code },
  });
}

/**
 * The approved account behind a request: the website's waitlist session cookie
 * or the desktop app's bearer token. Returns `{ row }` or an error shape.
 */
export function approvedRequest({ req, db, auth }) {
  const profile = auth?.profileFor?.(req);
  if (profile) {
    return profile.waitlist_status === "approved"
      ? { row: profile }
      : {
          status: 403,
          code: "not_approved",
          message: "Hook is not enabled for this account yet.",
        };
  }
  return apiUser(db, req);
}
