/**
 * The personal model endpoint, synced between an account's devices.
 *
 * Setting your own OpenAI-compatible endpoint should not mean typing the same
 * key into the desktop, Workspace and the phone. For a paid account with cloud
 * sync on, the app keeps one copy here and every device adopts it.
 *
 * A provider key is a credential, so it is handled differently from the rest of
 * the synced data:
 *
 * - the database stores AES-256-GCM ciphertext, never the key. The encryption
 *   key is derived (HKDF-SHA256) from `HOOK_PROVIDER_SECRET`, a deployment
 *   secret that is not in this repository;
 * - the account subject is the GCM additional data, so a row copied to another
 *   account cannot be decrypted;
 * - `GET /api/provider` returns metadata only. The key has its own route so a
 *   response body that ends up in a log, a proxy trace or a bug report cannot
 *   contain it. Every response is `no-store`;
 * - the routes are refused for a free account (`sync_not_included`) and for an
 *   account whose sync switch is off (`sync_disabled`), the same rule
 *   `server/sync.mjs` applies to conversations. Turning sync off therefore
 *   keeps the key on the device that typed it, and the desktop stops pushing
 *   it.
 *
 * Last write wins on the device's clock, like memory and chats: the app sends
 * the timestamp it recorded when the user saved or cleared the endpoint. A
 * clear is a tombstone with the fields emptied, so it beats a stale push from a
 * device that had not seen it yet, and no secret lingers in the row.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { Router, json } from "express";
import { apiUser } from "./tokens.mjs";
import { syncRefusal } from "./plans.mjs";

const MAX_BODY = "32kb";
const SALT = "hook-account-provider-v1";
const INFO = "personal-endpoint-key";
const MIN_SECRET = 32;

/** Errors the client shows as plain words rather than a stack. */
function fail(res, status, code, message) {
  res.status(status).json({
    error: { message, type: "invalid_request_error", code },
  });
}

function unavailable(res) {
  fail(
    res,
    503,
    "provider_sync_unavailable",
    "Saving your endpoint to the account is not configured on this server.",
  );
}

/**
 * The AES key, or null when the deployment has no secret. Failing closed is the
 * point: without a secret the service refuses to store a key instead of writing
 * one in plain text.
 */
function cipherKey(env) {
  const secret = typeof env.HOOK_PROVIDER_SECRET === "string"
    ? env.HOOK_PROVIDER_SECRET.trim()
    : "";
  if (secret.length < MIN_SECRET) return null;
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(SALT, "utf8"), Buffer.from(INFO, "utf8"), 32),
  );
}

function encrypt(key, subject, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(subject, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    cipher: body.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Null when the ciphertext does not belong to this account or key. */
function decrypt(key, subject, row) {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(row.key_iv, "base64"),
    );
    decipher.setAAD(Buffer.from(subject, "utf8"));
    decipher.setAuthTag(Buffer.from(row.key_tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.key_cipher, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The same shapes the desktop accepts in `settings.rs`, so an endpoint that
 * works locally is the one that gets stored, and a value that cannot work is
 * refused here rather than shipped to another device.
 */
function normalizeUrl(raw) {
  const value = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (!value || value.length > 300) return null;
  if (/[\u0000-\u001f]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  if (url.username || url.password) return null;
  return value;
}

function normalizeModel(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 200) return null;
  if (/[\s\u0000-\u001f]/.test(value)) return null;
  return value;
}

function normalizeApiKey(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 4000) return null;
  if (/[\s\u0000-\u001f]/.test(value)) return null;
  return value;
}

/** What `GET /api/provider` may say: never the key. */
function metadata(row) {
  if (!row || row.deleted === 1 || !row.base_url) return null;
  return {
    baseUrl: row.base_url,
    model: row.model,
    hasKey: Boolean(row.key_cipher),
    updatedAt: row.updated_at,
  };
}

export function createProviderRouter({ env = {}, db }) {
  const router = Router();
  const key = cipherKey(env);
  const select = db.prepare(
    "SELECT * FROM account_provider WHERE google_subject = ?",
  );
  const upsert = db.prepare(`
    INSERT INTO account_provider
      (google_subject, base_url, model, key_cipher, key_iv, key_tag, updated_at, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(google_subject) DO UPDATE SET
      base_url = excluded.base_url,
      model = excluded.model,
      key_cipher = excluded.key_cipher,
      key_iv = excluded.key_iv,
      key_tag = excluded.key_tag,
      updated_at = excluded.updated_at,
      deleted = excluded.deleted
  `);

  /**
   * The account behind an app token that may sync. A personal endpoint is
   * account data, so a free plan (no sync) and an account that turned its sync
   * switch off are both refused, exactly as `/api/sync` refuses them.
   */
  function account(req, res) {
    const result = apiUser(db, req);
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
    const refusal = syncRefusal(result.row);
    if (refusal) {
      fail(res, 403, refusal.code, refusal.message);
      return null;
    }
    return result.row;
  }

  router.get("/", (req, res) => {
    const row = account(req, res);
    if (!row) return;
    const stored = select.get(row.google_subject);
    res.json({
      provider: metadata(stored),
      updatedAt: stored?.updated_at ?? 0,
    });
  });

  /**
   * The key itself, for a device that is adopting this provider. Kept off the
   * metadata route on purpose; see the module comment.
   */
  router.get("/secret", (req, res) => {
    const row = account(req, res);
    if (!row) return;
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    const stored = select.get(row.google_subject);
    const meta = metadata(stored);
    if (!meta) return res.json({ provider: null, updatedAt: stored?.updated_at ?? 0 });
    if (!key) return unavailable(res);
    const apiKey = stored.key_cipher ? decrypt(key, row.google_subject, stored) : null;
    if (!apiKey) {
      // The deployment secret changed, or this row was written by another
      // server. The device keeps its local copy; re-saving it fixes this.
      console.error("hook: could not decrypt a stored provider key");
      fail(
        res,
        503,
        "provider_unreadable",
        "This account's saved endpoint could not be read. Save it again on a computer.",
      );
      return;
    }
    res.json({
      provider: {
        baseUrl: stored.base_url,
        model: stored.model,
        apiKey,
        updatedAt: stored.updated_at,
      },
      updatedAt: stored.updated_at,
    });
  });

  /**
   * Push the endpoint this device has. `provider: null` clears it everywhere;
   * `apiKey` is optional when re-saving the same endpoint, so a window that
   * never reads the key back can still change the URL or model.
   */
  router.put("/", json({ limit: MAX_BODY }), (req, res) => {
    const row = account(req, res);
    if (!row) return;
    const subject = row.google_subject;
    const body = req.body ?? {};
    const updatedAt = body.updatedAt;
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0)
      return fail(res, 400, "invalid_request_error", "A provider change needs a timestamp.");
    // `provider: null` is a clear. A body that simply forgot the field must not
    // be read as one — that would delete a key instead of storing it.
    if (!Object.hasOwn(body, "provider"))
      return fail(res, 400, "invalid_request_error", "Say whether this is an endpoint or a clear.");
    const stored = select.get(subject);

    // An older stamp never wins; an identical one is the same fact, so it is
    // accepted without a new revision and the devices stop echoing each other.
    if (stored && stored.updated_at >= updatedAt) {
      return res.json({
        provider: metadata(stored),
        updatedAt: stored.updated_at,
        unchanged: true,
      });
    }

    if (body.provider === null) {
      // A tombstone: the fields are emptied, so nothing secret stays behind.
      upsert.run(subject, "", "", "", "", "", updatedAt, 1);
      return res.json({ provider: null, updatedAt });
    }

    const incoming = body.provider;
    if (typeof incoming !== "object" || Array.isArray(incoming))
      return fail(res, 400, "invalid_request_error", "That provider is not shaped like one.");
    const baseUrl = normalizeUrl(incoming.baseUrl);
    if (!baseUrl)
      return fail(res, 400, "invalid_endpoint", "That endpoint is not an http:// or https:// URL.");
    const model = normalizeModel(incoming.model);
    if (!model)
      return fail(res, 400, "invalid_model", "That model name contains an invalid character.");
    const apiKey = normalizeApiKey(incoming.apiKey);
    // Keeping the stored key is what lets any device edit the endpoint without
    // ever receiving the secret.
    const keepStored = Boolean(
      !apiKey && stored && stored.deleted === 0 && stored.key_cipher,
    );
    if (!apiKey && !keepStored)
      return fail(res, 400, "invalid_key", "Enter the API key for this endpoint.");
    if (!key) return unavailable(res);

    let sealed;
    if (apiKey) {
      sealed = encrypt(key, subject, apiKey);
    } else {
      sealed = {
        cipher: stored.key_cipher,
        iv: stored.key_iv,
        tag: stored.key_tag,
      };
    }
    upsert.run(
      subject,
      baseUrl,
      model,
      sealed.cipher,
      sealed.iv,
      sealed.tag,
      updatedAt,
      0,
    );
    res.json({ provider: metadata(select.get(subject)), updatedAt });
  });

  return router;
}
