import { randomBytes } from "node:crypto";
import { json, Router } from "express";
import { planOf, quotaView } from "./plans.mjs";
import { apiUser, bearerToken, deviceId, hashToken } from "./tokens.mjs";

const DEVICE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 2;
// Unambiguous alphabet: no 0/O, 1/I/L.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const START_LIMIT = 20;
const START_WINDOW_MS = 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function userCode() {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    raw += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeUserCode(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === CODE_LENGTH ? cleaned : null;
}

function publicUser(row) {
  return {
    subject: row.google_subject,
    email: row.email,
    name: row.name ?? null,
    approved: row.waitlist_status === "approved",
    // The entitlement every product reads. `free` restricts sync, the daily
    // message count and coding agents; any other value is a paid plan.
    plan: planOf(row),
    // One switch per account, not per product: turning it off in Hook turns it
    // off in Workspace and on the phone too.
    cloudSync: Number(row.cloud_sync) !== 0,
  };
}

/**
 * Desktop sign-in uses the OAuth device pattern:
 *
 *   1. the app posts /device/start and receives a secret device code plus a
 *      short user code and a hookcode.io/authorize URL;
 *   2. the app opens that URL in the system browser, where the user signs in
 *      with Google and approves the device;
 *   3. the app polls /device/poll and receives the opaque API token once.
 *
 * The token is stored hashed and approval is checked again by every proxied
 * request, so unapproving an account takes effect on its next call.
 */
export function createAuthRouter({ db, auth, presence }) {
  const router = Router();
  router.use(json({ limit: "16kb" }));

  // The website's approval POSTs must come from hookcode.io itself. The native
  // app's start/poll calls have no Origin header and are unaffected.
  function requireOrigin(req, res) {
    if (req.get("origin") !== auth.site.origin) {
      res.status(403).json({ error: "origin" });
      return false;
    }
    return true;
  }

  const starts = new Map();
  function allowStart(req) {
    const forwarded = req.get("x-forwarded-for");
    const key = (forwarded ? forwarded.split(",")[0] : req.ip) || "unknown";
    const now = Date.now();
    const entry = starts.get(key);
    if (!entry || now - entry.at > START_WINDOW_MS) {
      starts.set(key, { at: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (starts.size > 10_000) starts.clear();
    return entry.count <= START_LIMIT;
  }

  const findLogin = db
    ? db.prepare("SELECT * FROM desktop_logins WHERE device_hash = ?")
    : null;
  const findUserCode = db
    ? db.prepare("SELECT * FROM desktop_logins WHERE user_code = ?")
    : null;
  const findSignup = db
    ? db.prepare("SELECT * FROM waitlist_signups WHERE google_subject = ?")
    : null;

  /** The one way an app token is minted, whichever door the account came in by. */
  function mintAppToken(subject, label, req) {
    const token = `hk_${randomBytes(32).toString("base64url")}`;
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, ?, ?, 'app', ?)`,
    ).run(hashToken(token), subject, label, deviceId(req));
    return token;
  }

  // A phone may not hammer the ID-token verifier: each call is a set of Google
  // certificate fetches, and the token is checked, not our own arithmetic.
  const googleStarts = new Map();
  function allowGoogle(req) {
    const forwarded = req.get("x-forwarded-for");
    const key = (forwarded ? forwarded.split(",")[0] : req.ip) || "unknown";
    const now = Date.now();
    const entry = googleStarts.get(key);
    if (!entry || now - entry.at > START_WINDOW_MS) {
      googleStarts.set(key, { at: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (googleStarts.size > 10_000) googleStarts.clear();
    return entry.count <= START_LIMIT;
  }

  /**
   * What a native client needs before it can call Google: the web (server)
   * client id its ID token must be issued for. Public — it is in every page of
   * the site — and answered without a session, because the caller has none yet.
   * Reading it here rather than baking it into a build keeps one deployment's
   * client out of another's app.
   */
  router.get("/config", (_req, res) => {
    res.json({ googleClientId: auth.clientId ?? null });
  });

  /**
   * Native sign-in. The phone's own account sheet answers a Google ID token;
   * this checks who it belongs to and hands back the same app token the device
   * flow issues, under the same approval rule. No browser, no code to type.
   *
   * The token's audience is the web client id, and only an app signed with the
   * registered package name and certificate can obtain one — so "verified by
   * Google, for our client, from our app" is what the check buys.
   */
  router.post("/google", async (req, res) => {
    if (!db || !auth.verifyGoogleIdToken)
      return res.status(503).json({ error: "unavailable" });
    if (!allowGoogle(req)) return res.status(429).json({ error: "rate_limited" });

    const idToken =
      typeof req.body?.idToken === "string" ? req.body.idToken : "";
    if (idToken.length < 100 || idToken.length > 8192)
      return res.status(400).json({ error: "invalid_token" });

    let account;
    try {
      account = await auth.verifyGoogleIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "invalid_token" });
    }
    if (!account?.sub || !account.email || account.email_verified !== true)
      return res.status(401).json({ error: "unverified" });

    const row = findSignup.get(account.sub);
    if (!row || row.waitlist_status !== "approved")
      return res.status(403).json({ error: "not_approved" });

    // A verified token proves an email; the account row is what proves it is
    // the same person who signed up, so the identity is reconciled from the row.
    res.json({
      token: mintAppToken(row.google_subject, "Hook mobile", req),
      user: publicUser(row),
      quota: quotaView(db, row),
    });
  });

  router.post("/device/start", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    if (!allowStart(req))
      return res.status(429).json({ error: "rate_limited" });

    // Housekeeping: these rows are worthless once the app stopped polling.
    db.prepare("DELETE FROM desktop_logins WHERE expires_at < ?").run(nowIso());

    let code = userCode();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (!findUserCode.get(code.replace("-", ""))) break;
      code = userCode();
    }
    const deviceCode = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + DEVICE_TTL_MS).toISOString();
    db.prepare(
      `INSERT INTO desktop_logins (device_hash, user_code, expires_at)
       VALUES (?, ?, ?)`,
    ).run(hashToken(deviceCode), code.replace("-", ""), expiresAt);

    const verificationUrl = new URL("/authorize", auth.site);
    verificationUrl.searchParams.set("code", code);
    res.json({
      deviceCode,
      userCode: code,
      verificationUrl: verificationUrl.toString(),
      expiresAt,
      interval: POLL_INTERVAL_SECONDS,
    });
  });

  router.post("/device/poll", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const deviceCode =
      typeof req.body?.deviceCode === "string" ? req.body.deviceCode : "";
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(deviceCode))
      return res.status(400).json({ error: "invalid_code" });

    const row = findLogin.get(hashToken(deviceCode));
    if (!row || row.expires_at <= nowIso())
      return res.json({ status: "expired" });
    if (row.claimed_at) return res.json({ status: "claimed" });
    if (row.status !== "approved" || !row.google_subject)
      return res.json({ status: "pending" });

    const user = db
      .prepare("SELECT * FROM waitlist_signups WHERE google_subject = ?")
      .get(row.google_subject);
    if (!user || user.waitlist_status !== "approved")
      return res.json({ status: "expired" });

    let token = "";
    db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = db
        .prepare(
          `UPDATE desktop_logins SET claimed_at = ?
           WHERE device_hash = ? AND claimed_at IS NULL`,
        )
        .run(nowIso(), row.device_hash);
      if (claimed.changes !== 1) {
        db.exec("ROLLBACK");
        return res.json({ status: "claimed" });
      }
      token = mintAppToken(row.google_subject, "Hook desktop", req);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    res.json({
      status: "approved",
      token,
      user: publicUser(user),
      quota: quotaView(db, user),
    });
  });

  router.post("/device/approve", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    if (!requireOrigin(req, res)) return;
    const profile = auth.profileFor(req);
    if (!profile) return res.status(401).json({ error: "signin_required" });
    if (profile.waitlist_status !== "approved")
      return res.status(403).json({ error: "not_approved" });

    const code = normalizeUserCode(req.body?.userCode);
    if (!code) return res.status(400).json({ error: "invalid_code" });
    const row = findUserCode.get(code);
    if (!row || row.expires_at <= nowIso())
      return res.status(410).json({ error: "expired" });
    if (row.claimed_at) return res.status(409).json({ error: "already_used" });
    if (
      row.google_subject &&
      row.google_subject !== profile.google_subject
    )
      return res.status(409).json({ error: "account_changed" });

    db.prepare(
      `UPDATE desktop_logins SET
         google_subject = ?, status = 'approved', approved_at = ?
       WHERE user_code = ? AND claimed_at IS NULL`,
    ).run(profile.google_subject, nowIso(), code);
    res.json({
      approved: true,
      userCode: `${code.slice(0, 4)}-${code.slice(4)}`,
      email: profile.email,
    });
  });

  /**
   * The desktop app asks this on launch to notice a revoked account, a plan
   * change or a sync switch flipped on another product. The quota is computed
   * here so the window can say "42 of 100" without a second call.
   */
  router.get("/me", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const result = apiUser(db, req);
    if (!result.row)
      return res.status(result.status).json({
        error: {
          message: result.message,
          type: "invalid_request_error",
          code: result.code,
        },
      });
    res.json({
      authenticated: true,
      user: publicUser(result.row),
      quota: quotaView(db, result.row),
    });
  });

  /**
   * Account-level preferences every product shares.
   *
   * Today that is `cloudSync`: whether conversations, projects, pictures and
   * memories may leave this account's computers. A paid account may turn it
   * off; a free account never syncs, and the setting is refused rather than
   * silently ignored.
   */
  router.post("/preferences", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const result = apiUser(db, req);
    if (!result.row)
      return res.status(result.status).json({
        error: {
          message: result.message,
          type: "invalid_request_error",
          code: result.code,
        },
      });
    if (planOf(result.row) === "free")
      return res.status(403).json({
        error: {
          message: "Cloud sync is part of a paid plan.",
          type: "invalid_request_error",
          code: "sync_not_included",
        },
      });
    const body = req.body ?? {};
    if (
      Object.keys(body).length !== 1 ||
      typeof body.cloudSync !== "boolean"
    )
      return res.status(400).json({ error: "invalid_preferences" });
    db.prepare(
      "UPDATE waitlist_signups SET cloud_sync = ? WHERE google_subject = ?",
    ).run(body.cloudSync ? 1 : 0, result.row.google_subject);
    // The relay is account data too: turning sync off stops the live
    // connection on every device, not just the next sync cycle. They reconnect
    // and get the refusal, which the UI shows in plain words.
    if (!body.cloudSync) {
      presence?.closeSubject(result.row.google_subject);
    }
    const row = findSignup.get(result.row.google_subject);
    res.json({ user: publicUser(row), quota: quotaView(db, row) });
  });

  /**
   * Mint a git-only token for this install. The app token can spend model
   * credits and read conversations; a repository or a leaked agent environment
   * must never carry that. One git token per device is kept: minting a new one
   * revokes the previous one for the same install.
   */
  router.post("/git-token", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const result = apiUser(db, req, "app");
    if (!result.row)
      return res.status(result.status).json({
        error: {
          message: result.message,
          type: "invalid_request_error",
          code: result.code,
        },
      });
    const device = deviceId(req);
    const label =
      typeof req.body?.label === "string" && req.body.label.trim()
        ? req.body.label.trim().slice(0, 80)
        : "Hook git";
    const token = `hk_git_${randomBytes(32).toString("base64url")}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (device)
        db.prepare(
          `UPDATE api_tokens SET revoked_at = ?
           WHERE google_subject = ? AND scope = 'git' AND device_id = ?
             AND revoked_at IS NULL`,
        ).run(nowIso(), result.row.google_subject, device);
      db.prepare(
        `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
         VALUES (?, ?, ?, 'git', ?)`,
      ).run(hashToken(token), result.row.google_subject, label, device);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    res.json({ token, device });
  });

  /** Signing out of the desktop app revokes just that token. */
  router.post("/token/logout", (req, res) => {
    if (!db) return res.status(503).json({ error: "unavailable" });
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: "missing_token" });
    const row = db
      .prepare(
        "SELECT google_subject, device_id FROM api_tokens WHERE token_hash = ?",
      )
      .get(hashToken(token));
    db.prepare(
      `UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE token_hash = ? AND revoked_at IS NULL`,
    ).run(hashToken(token));
    // The install that signed out must not leave a usable git credential
    // behind, but other computers on the same account stay signed in.
    if (row?.device_id)
      db.prepare(
        `UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE google_subject = ? AND device_id = ? AND scope = 'git'
           AND revoked_at IS NULL`,
      ).run(row.google_subject, row.device_id);
    res.json({ ok: true });
  });

  return router;
}
