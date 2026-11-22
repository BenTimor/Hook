import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { json, Router } from "express";
import { OAuth2Client } from "google-auth-library";
import content from "../waitlist/content.json" with { type: "json" };
import { storeListing } from "./releases.mjs";

const FLOW_SECONDS = 600;
const RECEIPT_SECONDS = 7 * 24 * 60 * 60;
const CALLBACK_PATH = "/api/waitlist/google/callback";
const interestIds = new Set(content.interests.map((interest) => interest.id));
const planIds = new Set(content.pricing.plans.map((plan) => plan.id));
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function progressEventsFrom(body) {
  if (
    !body ||
    !Array.isArray(body.events) ||
    body.events.length < 1 ||
    body.events.length > 25
  ) {
    throw new Error("Invalid progress events");
  }
  for (const event of body.events) {
    if (
      !event ||
      typeof event.eventId !== "string" ||
      typeof event.clientId !== "string" ||
      !/^[\w-]{8,80}$/.test(event.eventId) ||
      !/^[\w-]{8,80}$/.test(event.clientId) ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1
    )
      throw new Error("Invalid progress event");
    const valid =
      (event.type === "interest_changed" &&
        interestIds.has(event.interestId) &&
        typeof event.selected === "boolean") ||
      (event.type === "step_changed" &&
        ["interests", "pricing"].includes(event.step)) ||
      (["plan_selected", "completed"].includes(event.type) &&
        planIds.has(event.planPreference));
    if (!valid) throw new Error("Invalid progress event");
  }
  return body.events;
}

function publicProfile(row) {
  return {
    id: row.google_subject,
    name: row.name,
    email: row.email,
    interests: JSON.parse(row.interests),
    planPreference: row.plan_preference,
    selectedPrice:
      row.plan_price_cents === null
        ? null
        : {
            amountCents: row.plan_price_cents,
            currency: row.plan_currency,
            period: row.plan_period,
          },
    joinedAt: row.joined_at,
    status: row.waitlist_status,
    approved: row.waitlist_status === "approved",
    // The plan the admin assigned on approval, or null while this person is
    // still on the waitlist. Approving without choosing one makes it `free`.
    plan: row.plan ?? null,
    cloudSync: Number(row.cloud_sync) !== 0,
    approvedAt: row.approved_at ?? null,
    onboardingStep: row.onboarding_step,
    onboardingStartedAt: row.onboarding_started_at,
    onboardingUpdatedAt: row.onboarding_updated_at,
    onboardingCompletedAt: row.onboarding_completed_at,
  };
}

/** Hash a bearer token before it touches the database. */
export function hashSecret(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Only same-origin relative paths are accepted as post-login destinations, so
 * `/google?next=` can never become an open redirect.
 */
export function safeNext(raw, site) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 300 || !value.startsWith("/") || value.startsWith("//"))
    return null;
  if (value.includes("\\") || value.includes("\r") || value.includes("\n"))
    return null;
  try {
    const url = new URL(value, site);
    return url.origin === site.origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

function preferencesFrom(body) {
  if (body === undefined) return null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid preferences");
  if (Object.keys(body).length === 0) return null;
  if (
    !Array.isArray(body.interests) ||
    body.interests.length > interestIds.size ||
    !body.interests.every((id) => interestIds.has(id)) ||
    !planIds.has(body.planPreference)
  ) {
    throw new Error("Invalid preferences");
  }
  return {
    interests: [...new Set(body.interests)],
    planPreference: body.planPreference,
  };
}

export function createWaitlistApi(env, { verifyGoogle } = {}) {
  const site = new URL(env.WAITLIST_ORIGIN || "http://localhost:5173");
  const local =
    site.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  if (
    (!local && site.protocol !== "https:") ||
    site.href !== `${site.origin}/`
  ) {
    throw new Error(
      "WAITLIST_ORIGIN must be a site origin, using HTTPS outside local development.",
    );
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.WAITLIST_SESSION_SECRET;
  const configured = Boolean(
    clientId && clientSecret && sessionSecret?.length >= 32,
  );
  if (!configured && (!local || clientId || clientSecret || sessionSecret)) {
    throw new Error(
      "Set both Google OAuth credentials and a WAITLIST_SESSION_SECRET of at least 32 characters.",
    );
  }

  const google = configured
    ? new OAuth2Client(clientId, clientSecret, `${site.origin}${CALLBACK_PATH}`)
    : null;
  const cookies = {
    httpOnly: true,
    secure: !local,
    sameSite: "lax",
    path: "/",
  };
  const prefix = local ? "" : "__Host-";
  const flowCookie = `${prefix}hook_flow`;
  const receiptCookie = `${prefix}hook_joined`;
  const router = Router();
  const db = configured ? openWaitlist(env.WAITLIST_DB_PATH) : null;
  const upsertIdentity = db?.prepare(`
    INSERT INTO waitlist_signups (google_subject, email, name) VALUES (?, ?, ?)
    ON CONFLICT(google_subject) DO UPDATE SET
      email = excluded.email, name = COALESCE(excluded.name, waitlist_signups.name)
  `);
  const savePreferences = db?.prepare(`
    UPDATE waitlist_signups SET interests = ?, plan_preference = ? WHERE google_subject = ?
  `);
  const findProfile = db?.prepare(
    "SELECT * FROM waitlist_signups WHERE google_subject = ?",
  );
  const beginOnboarding = db?.prepare(`UPDATE waitlist_signups SET
    onboarding_started_at = COALESCE(onboarding_started_at, ${NOW}),
    onboarding_updated_at = ${NOW} WHERE google_subject = ?`);
  const saveInterests = db?.prepare(`UPDATE waitlist_signups SET interests = ?,
    onboarding_updated_at = ${NOW} WHERE google_subject = ?`);
  const saveStep = db?.prepare(`UPDATE waitlist_signups SET onboarding_step = ?,
    onboarding_updated_at = ${NOW} WHERE google_subject = ?`);
  const savePlan = db?.prepare(`UPDATE waitlist_signups SET plan_preference = ?,
    plan_price_cents = ?, plan_currency = ?, plan_period = ?, onboarding_step = 'pricing',
    onboarding_updated_at = ${NOW} WHERE google_subject = ?`);
  const completeOnboarding =
    db?.prepare(`UPDATE waitlist_signups SET onboarding_step = 'completed',
    onboarding_completed_at = COALESCE(onboarding_completed_at, ${NOW}),
    onboarding_updated_at = ${NOW} WHERE google_subject = ?`);
  const findEvent = db?.prepare(
    "SELECT 1 FROM onboarding_events WHERE google_subject = ? AND event_id = ?",
  );
  const latestSequence =
    db?.prepare(`SELECT MAX(sequence) AS sequence FROM onboarding_events
    WHERE google_subject = ? AND client_id = ? AND field = ?`);
  const insertEvent = db?.prepare(`INSERT INTO onboarding_events
    (google_subject, event_id, client_id, sequence, field, event_type, details, applied)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  function choosePlan(subject, id) {
    const plan = content.pricing.plans.find((item) => item.id === id);
    const price = {
      amountCents: Math.round(plan.earlyPrice * 100),
      currency: content.pricing.currencyCode,
      period: content.pricing.period,
    };
    savePlan.run(id, price.amountCents, price.currency, price.period, subject);
    return price;
  }

  const sign = (data) =>
    createHmac("sha256", sessionSecret).update(data).digest("base64url");

  function writeCookie(res, name, payload, seconds) {
    const data = Buffer.from(
      JSON.stringify({ ...payload, expires: Date.now() + seconds * 1000 }),
    ).toString("base64url");
    res.cookie(name, `${data}.${sign(data)}`, {
      ...cookies,
      maxAge: seconds * 1000,
    });
  }

  function readCookie(req, name) {
    const value = req.headers.cookie
      ?.split(/;\s*/)
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    if (!configured || !value || !/^[\w-]+\.[\w-]{43}$/.test(value))
      return null;
    const [data, signature] = value.split(".");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(data))))
      return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    return payload.expires > Date.now() ? payload : null;
  }

  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });
  router.use((req, res, next) => {
    if (req.method === "POST" && req.get("origin") !== site.origin) {
      return res.status(403).json({ error: "origin" });
    }
    next();
  });
  router.use(json({ limit: "32kb" }));

  function profileFor(req) {
    const subject = readCookie(req, receiptCookie)?.subject;
    return typeof subject === "string" ? findProfile?.get(subject) : null;
  }

  function finishPreferences(res, subject, preferences) {
    db.exec("BEGIN IMMEDIATE");
    try {
      savePreferences.run(
        JSON.stringify(preferences.interests),
        preferences.planPreference,
        subject,
      );
      beginOnboarding.run(subject);
      choosePlan(subject, preferences.planPreference);
      completeOnboarding.run(subject);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    writeCookie(res, receiptCookie, { joined: true, subject }, RECEIPT_SECONDS);
    return res.json({ joined: true });
  }

  router.get("/status", (req, res) => {
    const receipt = readCookie(req, receiptCookie);
    const row = profileFor(req);
    res.json({
      joined: Boolean(row) || receipt?.joined === true,
      profile: row ? publicProfile(row) : null,
      // Approved accounts install Hook from the Microsoft Store: the button
      // opens the whitelisted listing, and the Store (not this server) decides
      // who may install from it. The direct installer is not linked here.
      ...(row?.waitlist_status === "approved"
        ? { store: storeListing(env) }
        : {}),
    });
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(receiptCookie, cookies);
    res.json({ joined: false });
  });

  router.post("/progress", (req, res) => {
    const profile = profileFor(req);
    if (!profile) return res.status(401).json({ error: "signin_required" });
    if (req.body?.subject !== profile.google_subject)
      return res.status(409).json({ error: "account_changed" });
    let events;
    try {
      events = progressEventsFrom(req.body);
    } catch {
      return res.status(400).json({ error: "invalid_progress" });
    }
    const subject = profile.google_subject;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        if (findEvent.get(subject, event.eventId)) continue;
        const field =
          event.type === "interest_changed"
            ? `interest:${event.interestId}`
            : "flow";
        const previous = latestSequence.get(
          subject,
          event.clientId,
          field,
        ).sequence;
        const applied = previous === null || event.sequence > previous;
        const details = { type: event.type };
        if (event.type === "interest_changed")
          Object.assign(details, {
            interestId: event.interestId,
            selected: event.selected,
          });
        else if (event.type === "step_changed") details.step = event.step;
        else details.planPreference = event.planPreference;
        if (applied) {
          const current = findProfile.get(subject);
          if (!current.onboarding_started_at) beginOnboarding.run(subject);
          if (event.type === "interest_changed") {
            const interests = new Set(JSON.parse(current.interests));
            if (event.selected) interests.add(event.interestId);
            else interests.delete(event.interestId);
            saveInterests.run(JSON.stringify([...interests]), subject);
          } else if (event.type === "step_changed") {
            saveStep.run(event.step, subject);
          } else if (event.type === "plan_selected") {
            details.price = choosePlan(subject, event.planPreference);
          } else {
            if (current.plan_preference !== event.planPreference) {
              db.exec("ROLLBACK");
              return res.status(409).json({ error: "plan_required" });
            }
            completeOnboarding.run(subject);
          }
        }
        insertEvent.run(
          subject,
          event.eventId,
          event.clientId,
          event.sequence,
          field,
          event.type,
          JSON.stringify(details),
          Number(applied),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    res.json({ profile: publicProfile(findProfile.get(subject)) });
  });

  router.post("/preferences", (req, res) => {
    const profile = profileFor(req);
    if (!profile) return res.status(401).json({ error: "signin_required" });
    let preferences;
    try {
      preferences = preferencesFrom(req.body);
      if (!preferences) throw new Error("Missing preferences");
    } catch {
      return res.status(400).json({ error: "invalid_preferences" });
    }
    return finishPreferences(res, profile.google_subject, preferences);
  });

  router.post("/google", async (req, res) => {
    if (!google) return res.status(503).json({ error: "unavailable" });
    let preferences;
    try {
      preferences =
        req.body?.mode === "onboarding" ? null : preferencesFrom(req.body);
    } catch {
      return res.status(400).json({ error: "invalid_preferences" });
    }
    const next = safeNext(req.body?.next, site);

    const profile = profileFor(req);
    if (profile && preferences)
      return finishPreferences(res, profile.google_subject, preferences);
    if (profile)
      return res.json({ authenticated: true, profile: publicProfile(profile) });

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const { codeVerifier, codeChallenge } =
      await google.generateCodeVerifierAsync();
    const url = google.generateAuthUrl({
      scope: ["openid", "email", "profile"],
      prompt: "select_account",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    writeCookie(
      res,
      flowCookie,
      {
        state,
        nonce,
        codeVerifier,
        preferences,
        next,
        onboarding: req.body?.mode === "onboarding",
      },
      FLOW_SECONDS,
    );
    res.json({ url });
  });

  router.get("/google/callback", async (req, res) => {
    const flow = readCookie(req, flowCookie);
    const { state, code, error } = req.query;
    if (!google || !flow || state !== flow.state)
      return res.redirect(303, "/?signup=expired");

    // Errors go back to the page that started sign-in (e.g. /authorize) so it
    // can explain what happened instead of dropping the code on the floor.
    const returnTo = safeNext(flow.next, site);
    const failure = (reason) => {
      const destination = new URL(returnTo ?? "/", site);
      destination.searchParams.set("signup", reason);
      return `${destination.pathname}${destination.search}`;
    };

    res.clearCookie(flowCookie, cookies);
    if (error === "access_denied")
      return res.redirect(303, failure("cancelled"));
    if (error || typeof code !== "string" || !code)
      return res.redirect(303, failure("failed"));

    try {
      const { tokens } = await google.getToken({
        code,
        codeVerifier: flow.codeVerifier,
      });
      if (!tokens.id_token) throw new Error("Missing ID token");

      const ticket = await google.verifyIdToken({
        idToken: tokens.id_token,
        audience: clientId,
      });
      const account = ticket.getPayload();
      if (
        !account ||
        account.nonce !== flow.nonce ||
        !account.sub ||
        !account.email ||
        account.email_verified !== true
      ) {
        return res.redirect(303, failure("unverified"));
      }

      // Detect a genuinely new waitlist row inside the write transaction so
      // concurrent callbacks cannot both treat the same account as new.
      let newSignup = false;
      db.exec("BEGIN IMMEDIATE");
      try {
        newSignup = !findProfile.get(account.sub);
        upsertIdentity.run(
          account.sub,
          account.email,
          typeof account.name === "string" ? account.name : null,
        );
        beginOnboarding.run(account.sub);
        if (flow.preferences) {
          const preferences = preferencesFrom(flow.preferences);
          savePreferences.run(
            JSON.stringify(preferences.interests),
            preferences.planPreference,
            account.sub,
          );
          choosePlan(account.sub, preferences.planPreference);
          completeOnboarding.run(account.sub);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      writeCookie(
        res,
        receiptCookie,
        { joined: true, subject: account.sub },
        RECEIPT_SECONDS,
      );
      // Mark a new signup with lead=1 so the landing page sends the Meta Lead
      // event once. The flag is cleared from the URL by the page after firing.
      // A `next` destination (the desktop device-approval page) wins over the
      // default landing/onboarding destination.
      const destination = new URL(
        returnTo ?? (flow.onboarding ? "/?signup=authenticated" : "/"),
        site,
      );
      if (newSignup) destination.searchParams.set("lead", "1");
      res.redirect(303, `${destination.pathname}${destination.search}`);
    } catch {
      // OAuth errors can contain tokens or account details, so keep logs free of the response.
      console.error(
        "Hook waitlist: Google sign-in or signup persistence failed.",
      );
      res.redirect(303, failure("failed"));
    }
  });

  router.use((_req, res) => res.sendStatus(404));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "invalid_json" });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "too_large" });
    console.error("Hook waitlist: request failed.");
    res.status(500).json({ error: "failed" });
  });

  return {
    router,
    close: () => db?.close(),
    db,
    // Shared by the platform's device-login, API proxy and download routes.
    auth: {
      site,
      local,
      configured,
      cookies,
      receiptCookie,
      readCookie,
      writeCookie,
      profileFor,
      publicProfile,
      // What a phone needs to run the native Google sheet: the client id its ID
      // token must name, and the verifier that checks one. Both are absent when
      // this deployment has no Google credentials at all.
      clientId: configured ? clientId : null,
      verifyGoogleIdToken: configured
        ? verifyGoogle
          // Tests replace it: verifying a token means fetching Google's
          // certificates, which a test suite must not do.
          ? (idToken) => verifyGoogle(idToken, clientId)
          : (idToken) =>
              google
                .verifyIdToken({ idToken, audience: clientId })
                .then((ticket) => ticket.getPayload())
        : null,
    },
  };
}

function openWaitlist(dbPath = "waitlist-data/signups.sqlite") {
  const file = resolve(dbPath);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS waitlist_signups (
      google_subject TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);
  // Serialize schema upgrades so existing waitlists also work on concurrent starts.
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(waitlist_signups)")
        .all()
        .map((column) => column.name),
    );
    const additions = {
      name: "TEXT",
      interests: "TEXT NOT NULL DEFAULT '[]'",
      plan_preference: "TEXT",
      waitlist_status: "TEXT NOT NULL DEFAULT 'waitlisted'",
      onboarding_step: "TEXT NOT NULL DEFAULT 'interests'",
      onboarding_started_at: "TEXT",
      onboarding_updated_at: "TEXT",
      onboarding_completed_at: "TEXT",
      plan_price_cents: "INTEGER",
      plan_currency: "TEXT",
      plan_period: "TEXT",
      approved_at: "TEXT",
      revoked_at: "TEXT",
      // The entitlement, not the waitlist preference: `free`, `plus` or `pro`,
      // and null until the account is approved. Approval assigns `free` unless
      // the admin picked a paid plan; the waitlist itself grants nothing.
      plan: "TEXT",
      // The account-level switch every product reads. Free accounts never sync,
      // whatever this says.
      cloud_sync: "INTEGER NOT NULL DEFAULT 1",
      // The display preference every product shares: thinking, tool calls and
      // the coding-agent inspector. Null until somebody sets it, so a device
      // that had the switch on before this column existed keeps its own answer
      // instead of being quietly reset by the upgrade.
      advanced_mode: "INTEGER",
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.has(name))
        db.exec(
          `ALTER TABLE waitlist_signups ADD COLUMN ${name} ${definition}`,
        );
    }
    if (!columns.has("onboarding_step")) {
      db.exec(
        "UPDATE waitlist_signups SET onboarding_step = 'completed' WHERE plan_preference IS NOT NULL",
      );
    }
    // The first run that has plans at all. Approval is what assigns one: every
    // account approved before this change starts free, and a waitlisted row
    // keeps a null plan so the admin views cannot count people who have not been
    // let in yet.
    if (!columns.has("plan")) {
      db.exec(
        "UPDATE waitlist_signups SET plan = 'free' WHERE waitlist_status = 'approved' AND plan IS NULL",
      );
    }
    db.exec(`CREATE TABLE IF NOT EXISTS onboarding_events (
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      event_id TEXT NOT NULL, client_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      field TEXT NOT NULL, event_type TEXT NOT NULL, details TEXT NOT NULL,
      applied INTEGER NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (${NOW}),
      PRIMARY KEY (google_subject, event_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS onboarding_event_sequence
      ON onboarding_events (google_subject, client_id, field, sequence);

    -- One desktop sign-in attempt. The app holds the secret device code; the
    -- browser only ever sees the short user code shown in both places.
    CREATE TABLE IF NOT EXISTS desktop_logins (
      device_hash TEXT PRIMARY KEY NOT NULL,
      user_code TEXT NOT NULL UNIQUE,
      google_subject TEXT REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      claimed_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS desktop_login_expiry
      ON desktop_logins (expires_at);

    -- Opaque bearer token the desktop app presents to /api/v1. Only its hash
    -- is stored, and approval is re-checked on every request so revoking an
    -- account takes effect immediately.
    CREATE TABLE IF NOT EXISTS api_tokens (
      token_hash TEXT PRIMARY KEY NOT NULL,
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      last_used_at TEXT,
      revoked_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS api_token_owner
      ON api_tokens (google_subject);
    -- One row per proxied model request. Headers supplied by Hook identify the
    -- chat and coding-agent run so usage can be analysed per conversation.
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_subject TEXT NOT NULL,
      chat_id TEXT,
      agent_id TEXT,
      surface TEXT NOT NULL DEFAULT 'api',
      model TEXT,
      status INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      ttft_ms INTEGER,
      -- The plan in force when the request was served, so usage can be read by
      -- plan later without joining a column that may since have changed.
      plan TEXT NOT NULL DEFAULT 'free',
      -- The user message this request belongs to. Several model calls of one
      -- turn share it, which is how the free daily limit counts messages
      -- instead of requests.
      message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW})
    ) STRICT;
    CREATE INDEX IF NOT EXISTS usage_event_owner
      ON usage_events (google_subject, created_at);
    CREATE INDEX IF NOT EXISTS usage_event_chat
      ON usage_events (chat_id);
    CREATE INDEX IF NOT EXISTS usage_event_agent
      ON usage_events (agent_id);

    -- In-app reports of inappropriate AI output (Microsoft Store policy 11.16).
    CREATE TABLE IF NOT EXISTS ai_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      chat_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      note TEXT,
      content TEXT NOT NULL,
      transcript TEXT,
      app_version TEXT,
      -- "ai" for a model reply, "content" for something a person wrote and a
      -- user reported through a preview (App Store 1.2 / Play UGC). One review
      -- queue on purpose: the same person reads both.
      subject_kind TEXT NOT NULL DEFAULT 'ai',
      -- JSON {"kind","id","title","projectId"} when subject_kind is "content".
      target TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      resolved_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ai_report_status
      ON ai_reports (status, created_at);
    CREATE INDEX IF NOT EXISTS ai_report_owner
      ON ai_reports (google_subject, created_at);

    -- What the app did that never reaches the model proxy: saving a personal
    -- provider, a turn answered by it, a turn refused by the free limit, the
    -- cloud-sync switch. Only a kind from a fixed list is stored; no text, no
    -- endpoint, no key. Read by scripts/waitlist-admin.sh --events.
    CREATE TABLE IF NOT EXISTS client_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      product TEXT NOT NULL DEFAULT 'unknown',
      app_version TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW})
    ) STRICT;
    CREATE INDEX IF NOT EXISTS client_event_owner
      ON client_events (google_subject, created_at);
    CREATE INDEX IF NOT EXISTS client_event_kind
      ON client_events (kind, created_at);`);

    // Scoped tokens: the desktop's app token can mint a git-only token, so a
    // repository (or an agent reading one) never holds a credential that can
    // spend model credits. The device id lets one install rotate its own git
    // tokens on sign-out without disturbing the account's other computers.
    const tokenColumns = new Set(
      db
        .prepare("PRAGMA table_info(api_tokens)")
        .all()
        .map((column) => column.name),
    );
    if (!tokenColumns.has("scope"))
      db.exec(
        "ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'app'",
      );
    if (!tokenColumns.has("device_id"))
      db.exec("ALTER TABLE api_tokens ADD COLUMN device_id TEXT");

    // Reports of other people's words share the AI queue; an existing database
    // predates the two columns that say which kind a row is.
    const reportColumns = new Set(
      db
        .prepare("PRAGMA table_info(ai_reports)")
        .all()
        .map((column) => column.name),
    );
    if (!reportColumns.has("subject_kind"))
      db.exec(
        "ALTER TABLE ai_reports ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'ai'",
      );
    if (!reportColumns.has("target"))
      db.exec("ALTER TABLE ai_reports ADD COLUMN target TEXT");

    // A database written before plans and per-message accounting existed.
    const usageColumns = new Set(
      db
        .prepare("PRAGMA table_info(usage_events)")
        .all()
        .map((column) => column.name),
    );
    if (!usageColumns.has("plan"))
      db.exec("ALTER TABLE usage_events ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
    if (!usageColumns.has("message_id"))
      db.exec("ALTER TABLE usage_events ADD COLUMN message_id TEXT");
    // The index names a migrated column, so it cannot live in the CREATE block
    // above: on an existing database that block is a no-op and the column is
    // only added here.
    db.exec(
      "CREATE INDEX IF NOT EXISTS usage_event_message ON usage_events (google_subject, message_id)",
    );

    db.exec(`
    -- A per-account monotonic cursor. Every accepted change bumps it, so one
    -- integer tells a device everything it has not seen yet.
    CREATE TABLE IF NOT EXISTS sync_state (
      google_subject TEXT PRIMARY KEY NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      next_seq INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    -- One row per conversation. The body is gzipped JSON; the hash lets an
    -- unchanged push become a no-op instead of a new revision.
    CREATE TABLE IF NOT EXISTS sync_chats (
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      hash TEXT NOT NULL,
      body BLOB,
      PRIMARY KEY (google_subject, chat_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sync_chat_seq
      ON sync_chats (google_subject, seq);

    -- Project identity and the description the chat agent maintains. The
    -- repository itself lives on disk (GIT_ROOT), keyed by the project id.
    CREATE TABLE IF NOT EXISTS sync_projects (
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (google_subject, project_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sync_project_seq
      ON sync_projects (google_subject, seq);
    CREATE INDEX IF NOT EXISTS sync_project_name
      ON sync_projects (google_subject, name_key);

    -- Pictures and other chat attachments, content-addressed by SHA-256. The
    -- bytes are files next to the database; this table is the index and quota.
    CREATE TABLE IF NOT EXISTS sync_media (
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      PRIMARY KEY (google_subject, sha256)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sync_media_owner
      ON sync_media (google_subject);

    -- What the chat agent remembers. One row per entry rather than one document
    -- per account, so two devices editing different memories merge instead of
    -- overwriting each other. The text column is the fact itself; deleted is a
    -- tombstone that beats a stale push, the same rule chats use.
    CREATE TABLE IF NOT EXISTS sync_memory (
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'user',
      pinned INTEGER NOT NULL DEFAULT 0,
      chat_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (google_subject, entry_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sync_memory_seq
      ON sync_memory (google_subject, seq);

    -- The personal model endpoint of an account that syncs it: one row per
    -- account. The key is AES-256-GCM ciphertext whose AAD is the account
    -- subject, never the key itself — a leaked database row is useless without
    -- HOOK_PROVIDER_SECRET, and a row copied to another account cannot be
    -- opened. A clear is a tombstone with the fields emptied, so it beats a
    -- stale push from a device that had not seen it yet.
    CREATE TABLE IF NOT EXISTS account_provider (
      google_subject TEXT PRIMARY KEY NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      base_url TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      key_cipher TEXT NOT NULL DEFAULT '',
      key_iv TEXT NOT NULL DEFAULT '',
      key_tag TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    -- The fact that a direct coding chat exists on a machine. The conversation
    -- itself stays there: no messages, no folder and no session ever enter this
    -- row. A viewer uses the stub to list the chat and to know which host to ask
    -- for the transcript. The device_id column is the owner; another device
    -- may not overwrite its stub.
    CREATE TABLE IF NOT EXISTS sync_remote_chats (
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'idle',
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (google_subject, chat_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sync_remote_chat_seq
      ON sync_remote_chats (google_subject, seq);

    -- One row per machine the account knows. This is the registry the relay
    -- and the Machines UI read; the live connection state is in memory and is
    -- merged in at read time. A name is the account's, not the device's: the
    -- first registration seeds it and every later one keeps it, so two products
    -- sharing a device id cannot rename each other on startup.
    CREATE TABLE IF NOT EXISTS devices (
      google_subject TEXT NOT NULL REFERENCES waitlist_signups(google_subject) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'desktop',
      platform TEXT,
      arch TEXT,
      app_version TEXT,
      product TEXT,
      can_host INTEGER NOT NULL DEFAULT 0,
      capabilities TEXT,
      specs TEXT,
      remote_allowed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      last_seen_at TEXT NOT NULL DEFAULT (${NOW}),
      PRIMARY KEY (google_subject, device_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS device_owner
      ON devices (google_subject, last_seen_at);`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  return db;
}
