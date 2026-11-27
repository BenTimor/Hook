import { json, Router } from "express";
import {
  FREE_IMAGE_LIMIT,
  imageQuotaUsed,
  imageRefusal,
  isFreePlan,
  planOf,
} from "./plans.mjs";
import { apiError, requireApiUser } from "./tokens.mjs";

/**
 * Making pictures, for an account rather than for whoever holds the binary.
 *
 * The desktop app, the phone and every coding agent send `{ prompt,
 * aspect_ratio?, n? }` here with the same opaque account token they use for the
 * model, and this deployment asks the image endpoint with its own key. Nothing
 * that ships carries that key: a picture is a server call, exactly like a
 * message.
 *
 * The upstream answer is passed through in the shape the endpoint uses
 * (`data: [{ b64_json, media_type }]`), because bytes are what the app stores:
 * a signed URL expires in a day, and the picture is meant to outlive the turn
 * that made it.
 *
 * Two things keep the key from being spent by a loop or by a new account:
 * `imageRefusal` gives a free plan a small daily window, and the limiter below
 * caps how much one account can have in flight at once.
 */

const DEFAULT_MODEL = "meta/muse-image";
/** Pictures one request may ask for, and the endpoint's own ceiling. */
const MAX_PER_CALL = 4;
/**
 * Reference pictures: the endpoint takes `input_references` as image URLs, and
 * Hook's app sends them as data URLs because the picture it works from is
 * usually one the conversation already holds. Only that shape is accepted - a
 * plain `https://` URL here would turn the route into an open fetcher.
 */
const MAX_REFERENCES = 10;
const MAX_REFERENCE_BYTES = 3 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 24 * 1024 * 1024;
const DATA_URL = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
/** A picture is a minute of work upstream; four of them are not four minutes. */
const UPSTREAM_TIMEOUT_MS = 180_000;
const MAX_CONCURRENT = 2;
const MAX_PER_MINUTE = 20;

function upstreamBase(env) {
  const base = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").trim();
  return base.replace(/\/+$/, "").replace(/\/images$/, "");
}

/** `16:9`, `2.35:1`, `9:19.5` — anything else is dropped, not forwarded. */
function cleanRatio(value) {
  if (typeof value !== "string") return null;
  const ratio = value.trim();
  return /^\d{1,4}(\.\d{1,3})?:\d{1,4}(\.\d{1,3})?$/.test(ratio) ? ratio : null;
}

/**
 * The reference pictures a request carries, checked as a batch.
 *
 * Each one is a data URL the app built from a picture in the chat or a file on
 * the user's computer; ten is the endpoint's own ceiling and the byte caps are
 * what keep one request from being a hundred megabytes.
 */
function cleanReferences(value) {
  if (value === undefined || value === null) return { urls: [] };
  if (!Array.isArray(value))
    return { error: "`references` must be an array of image data URLs." };
  if (value.length > MAX_REFERENCES)
    return { error: `A picture can work from at most ${MAX_REFERENCES} references.` };
  const urls = [];
  let total = 0;
  for (const entry of value) {
    if (typeof entry !== "string" || !DATA_URL.test(entry))
      return {
        error:
          "Each reference must be an image data URL (`data:image/png;base64,...`).",
      };
    const bytes = Math.floor((entry.length - entry.indexOf(",") - 1) * 0.75);
    if (bytes > MAX_REFERENCE_BYTES)
      return {
        error: `A reference picture is ${(bytes / 1_048_576).toFixed(1)} MB; the limit is ${
          MAX_REFERENCE_BYTES / 1_048_576
        } MB.`,
      };
    total += bytes;
    if (total > MAX_REFERENCE_TOTAL_BYTES)
      return { error: "The reference pictures together are too large." };
    urls.push(entry);
  }
  return { urls };
}

/**
 * Keep one account from filling the endpoint on its own. A per-process guard
 * like the model proxy's: the real spend control is the plan.
 */
function createLimiter(maxConcurrent = MAX_CONCURRENT, maxPerMinute = MAX_PER_MINUTE) {
  const buckets = new Map();
  return {
    acquire(subject) {
      const now = Date.now();
      let bucket = buckets.get(subject);
      if (!bucket) {
        bucket = { window: now, count: 0, active: 0 };
        buckets.set(subject, bucket);
      }
      if (now - bucket.window >= 60_000) {
        bucket.window = now;
        bucket.count = 0;
      }
      if (bucket.active >= maxConcurrent)
        return { ok: false, message: "A picture is already being made. Wait for it to finish." };
      if (bucket.count >= maxPerMinute)
        return { ok: false, message: "Too many pictures at once. Try again in a minute." };
      bucket.count += 1;
      bucket.active += 1;
      if (buckets.size > 10_000) buckets.clear();
      return { ok: true, release: () => (bucket.active = Math.max(0, bucket.active - 1)) };
    },
  };
}

export function createImageRouter({ env, db }) {
  const router = Router();
  // A prompt is a paragraph, but a request can also carry up to ten reference
  // pictures as data URLs, so the body is bounded by them rather than by the
  // prompt (`MAX_REFERENCE_*`).
  router.use(json({ limit: "40mb" }));
  const limiter = createLimiter();
  const apiKey = (env.OPENROUTER_API_KEY || "").trim();
  const model = (env.OPENROUTER_IMAGE_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  // One format for every model: the app stores, thumbnails and hands the picture
  // to the OS, and an extended WebP is the one the platform is least sure of.
  // Empty leaves the choice to the model, for one that has no `output_format`.
  const format = (env.OPENROUTER_IMAGE_FORMAT ?? "png").trim();
  const url = `${upstreamBase(env)}/images`;

  /**
   * One row per picture, so the free window counts pictures and the admin view
   * can add up what a month of them cost.
   */
  function record(req, row, pictures, status, started) {
    try {
      const insert = db.prepare(
        `INSERT INTO usage_events
           (google_subject, chat_id, agent_id, surface, model, status,
            duration_ms, plan, message_id)
         VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?)`,
      );
      const chatId = req.get("x-hook-chat-id") || null;
      const agentId = req.get("x-hook-agent-id") || null;
      const messageId = req.get("x-hook-message-id") || null;
      for (let index = 0; index < Math.max(1, pictures); index += 1) {
        insert.run(
          row.google_subject,
          chatId,
          agentId,
          model,
          status,
          // The first picture carries the whole wait; later ones are free.
          index === 0 ? Date.now() - started : 0,
          // The plan in force when the request was served, not read later.
          planOf(row),
          messageId,
        );
      }
    } catch (error) {
      // Usage must never take a picture down with it.
      console.error("hook: could not record picture usage", error.message);
    }
  }

  router.get("/quota", (req, res) => {
    const row = requireApiUser(db, req, res);
    if (!row) return;
    res.json(
      isFreePlan(row)
        ? {
            limit: FREE_IMAGE_LIMIT,
            used: imageQuotaUsed(db, row.google_subject),
          }
        : { limit: null, used: null },
    );
  });

  router.post("/", async (req, res) => {
    const row = requireApiUser(db, req, res);
    if (!row) return;
    if (!apiKey)
      return apiError(
        res,
        503,
        "Making pictures is not set up on this server yet.",
        "image_unavailable",
      );

    const refusal = imageRefusal(db, row);
    if (refusal) return apiError(res, 403, refusal.message, refusal.code);

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt)
      return apiError(res, 400, "`prompt` must describe the picture.", "invalid_prompt");
    if (prompt.length > 4000)
      return apiError(
        res,
        400,
        "That prompt is too long; describe the picture in a paragraph.",
        "invalid_prompt",
      );

    const wanted = Number.isInteger(body.n) ? body.n : 1;
    const count = Math.min(MAX_PER_CALL, Math.max(1, wanted));
    const references = cleanReferences(body.references);
    if (references.error)
      return apiError(res, 400, references.error, "invalid_references");

    const upstream = {
      model,
      prompt,
      n: count,
      // Inline bytes: the app stores the picture, and a signed URL expires.
      response_format: "b64_json",
    };
    if (references.urls.length) {
      upstream.input_references = references.urls.map((url) => ({
        type: "image_url",
        image_url: { url },
      }));
    }
    if (format) upstream.output_format = format;
    const ratio = cleanRatio(body.aspect_ratio);
    if (ratio) upstream.aspect_ratio = ratio;

    const slot = limiter.acquire(row.google_subject);
    if (!slot.ok) return apiError(res, 429, slot.message, "rate_limited");

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          // Attribution: OpenRouter shows it in the account's activity view.
          "http-referer": "https://hookcode.io",
          "x-title": "Hook",
          "user-agent": "Hook-Proxy/1.0",
        },
        body: JSON.stringify(upstream),
        signal: controller.signal,
      });

      if (!response.ok) {
        const raw = (await response.text()).slice(0, 2_000);
        let message = raw;
        try {
          const parsed = JSON.parse(raw);
          message = parsed?.error?.message || parsed?.message || raw;
        } catch {
          // Keep the endpoint's own text.
        }
        record(req, row, 0, response.status, started);
        if (response.status === 401 || response.status === 403) {
          // Never hand the endpoint's credential problem to the user as theirs.
          console.error(
            `hook: the picture endpoint rejected the server credentials (${response.status})`,
          );
          return apiError(
            res,
            502,
            "Making pictures is unavailable right now. Please try again shortly.",
            "upstream_auth",
          );
        }
        if (response.status === 402 || response.status === 429) {
          console.error(`hook: the picture endpoint refused for capacity: ${message}`);
          return apiError(
            res,
            429,
            "The picture service is busy right now. Try again in a moment.",
            "upstream_busy",
          );
        }
        return apiError(
          res,
          502,
          `Making the picture failed: ${message || response.status}`,
          "image_failed",
        );
      }

      const payload = await response.json();
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const pictures = data.filter(
        (entry) =>
          typeof entry?.b64_json === "string" && entry.b64_json.length > 0,
      );
      if (!pictures.length) {
        record(req, row, 0, 502, started);
        return apiError(
          res,
          502,
          "The picture service returned no picture.",
          "image_failed",
        );
      }
      record(req, row, pictures.length, 200, started);
      console.log(
        `hook: ${pictures.length} picture(s) for ${row.google_subject} (${Date.now() - started}ms)`,
      );
      res.json({
        created: payload.created ?? Math.floor(Date.now() / 1000),
        model,
        data: pictures,
      });
    } catch (error) {
      record(req, row, 0, 504, started);
      if (controller.signal.aborted && !res.headersSent)
        return apiError(
          res,
          504,
          "Making the picture took too long. Try again.",
          "image_timeout",
        );
      if (!res.headersSent)
        return apiError(
          res,
          502,
          `Making the picture failed: ${error.message}`,
          "image_failed",
        );
    } finally {
      clearTimeout(timer);
      slot.release();
    }
  });

  return router;
}
