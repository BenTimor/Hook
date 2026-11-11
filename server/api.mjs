import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";

const FLOW_SECONDS = 600;
const RECEIPT_SECONDS = 7 * 24 * 60 * 60;
const CALLBACK_PATH = "/api/waitlist/google/callback";

export function createWaitlistApi(env) {
  const site = new URL(env.WAITLIST_ORIGIN || "http://localhost:5173");
  const local = site.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname);
  if ((!local && site.protocol !== "https:") || site.href !== `${site.origin}/`) {
    throw new Error("WAITLIST_ORIGIN must be a site origin, using HTTPS outside local development.");
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.WAITLIST_SESSION_SECRET;
  const configured = Boolean(clientId && clientSecret && sessionSecret?.length >= 32);
  if (!configured && (!local || clientId || clientSecret || sessionSecret)) {
    throw new Error("Set both Google OAuth credentials and a WAITLIST_SESSION_SECRET of at least 32 characters.");
  }

  const google = configured ? new OAuth2Client(clientId, clientSecret, `${site.origin}${CALLBACK_PATH}`) : null;
  const cookies = { httpOnly: true, secure: !local, sameSite: "lax", path: "/" };
  const prefix = local ? "" : "__Host-";
  const flowCookie = `${prefix}hook_flow`;
  const receiptCookie = `${prefix}hook_joined`;
  const router = Router();
  const db = configured ? openWaitlist(env.WAITLIST_DB_PATH) : null;
  const upsert = db?.prepare(`
    INSERT INTO waitlist_signups (google_subject, email) VALUES (?, ?)
    ON CONFLICT(google_subject) DO UPDATE SET email = excluded.email
  `);

  const sign = (data) => createHmac("sha256", sessionSecret).update(data).digest("base64url");

  function writeCookie(res, name, payload, seconds) {
    const data = Buffer.from(JSON.stringify({ ...payload, expires: Date.now() + seconds * 1000 })).toString("base64url");
    res.cookie(name, `${data}.${sign(data)}`, { ...cookies, maxAge: seconds * 1000 });
  }

  function readCookie(req, name) {
    const value = req.headers.cookie?.split(/;\s*/).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!configured || !value || !/^[\w-]+\.[\w-]{43}$/.test(value)) return null;
    const [data, signature] = value.split(".");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(sign(data)))) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    return payload.expires > Date.now() ? payload : null;
  }

  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });

  router.get("/status", (req, res) => {
    res.json({ joined: readCookie(req, receiptCookie)?.joined === true });
  });

  router.post("/google", async (req, res) => {
    if (req.get("origin") !== site.origin) return res.status(403).json({ error: "origin" });
    if (!google) return res.status(503).json({ error: "unavailable" });

    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const { codeVerifier, codeChallenge } = await google.generateCodeVerifierAsync();
    const url = google.generateAuthUrl({
      scope: ["openid", "email"],
      prompt: "select_account",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    writeCookie(res, flowCookie, { state, nonce, codeVerifier }, FLOW_SECONDS);
    res.json({ url });
  });

  router.get("/google/callback", async (req, res) => {
    const flow = readCookie(req, flowCookie);
    const { state, code, error } = req.query;
    if (!google || !flow || state !== flow.state) return res.redirect(303, "/?signup=expired");

    res.clearCookie(flowCookie, cookies);
    if (error === "access_denied") return res.redirect(303, "/?signup=cancelled");
    if (error || typeof code !== "string" || !code) return res.redirect(303, "/?signup=failed");

    try {
      const { tokens } = await google.getToken({ code, codeVerifier: flow.codeVerifier });
      if (!tokens.id_token) throw new Error("Missing ID token");

      const ticket = await google.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const account = ticket.getPayload();
      if (!account || account.nonce !== flow.nonce || !account.sub || !account.email || account.email_verified !== true) {
        return res.redirect(303, "/?signup=unverified");
      }

      upsert.run(account.sub, account.email);
      writeCookie(res, receiptCookie, { joined: true }, RECEIPT_SECONDS);
      res.redirect(303, "/");
    } catch {
      // OAuth errors can contain tokens or account details, so keep logs free of the response.
      console.error("Hook waitlist: Google sign-in or signup persistence failed.");
      res.redirect(303, "/?signup=failed");
    }
  });

  router.use((_req, res) => res.sendStatus(404));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("Hook waitlist: request failed.");
    res.status(500).json({ error: "failed" });
  });

  return { router, close: () => db?.close() };
}

function openWaitlist(dbPath = "waitlist-data/signups.sqlite") {
  const file = resolve(dbPath);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS waitlist_signups (
      google_subject TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);
  return db;
}
