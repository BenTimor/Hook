/**
 * Making pictures is an account request, not a build-time secret.
 *
 * These tests pin the rules that make that safe: no token, no picture; a
 * deployment with no endpoint key answers honestly instead of spending one; a
 * free account has a daily window and a paid one does not; `n` is clamped and an
 * oversized prompt is refused before it reaches the endpoint; and the picture
 * bytes come back in the shape the app stores.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { FREE_IMAGE_LIMIT, imageQuotaUsed } from "./plans.mjs";
import { createPlatform } from "./platform.mjs";
import { hashToken } from "./tokens.mjs";

const PAID_TOKEN = "hk_paid_pictures_token_0123456789abcd";
const FREE_TOKEN = "hk_free_pictures_token_0123456789abcd";
const OTHER_TOKEN = "hk_other_pictures_token_0123456789abc";
const UPSTREAM_KEY = "sk-or-v1-not-a-real-key";

/** A 4x4 PNG, base64: what the endpoint sends back for a picture. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

async function setup(t, { env = {}, seen = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hook-images-test-"));
  const dbPath = join(directory, "signups.sqlite");

  // A stub for OpenRouter's Image API. It records what the service asked for,
  // so the tests can check the body the app's request turned into.
  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  upstreamApp.post("/api/v1/images", (req, res) => {
    seen.body = req.body;
    seen.authorization = req.get("authorization");
    if (seen.fail) {
      res.status(seen.fail).json({ error: { message: seen.failMessage ?? "nope" } });
      return;
    }
    res.json({
      created: 1_700_000_000,
      data: [{ b64_json: PNG_B64, media_type: "image/png" }],
    });
  });
  const upstream = createServer(upstreamApp);
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  seen.upstreamPort = upstream.address().port;

  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const api = createPlatform(
    {
      WAITLIST_ORIGIN: `http://127.0.0.1:${server.address().port}`,
      WAITLIST_DB_PATH: dbPath,
      GOOGLE_CLIENT_ID: "hook-images.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "fixture",
      WAITLIST_SESSION_SECRET: "s".repeat(48),
      OPENROUTER_BASE_URL: `http://127.0.0.1:${seen.upstreamPort}/api/v1`,
      OPENROUTER_API_KEY: UPSTREAM_KEY,
      ...env,
    },
    { verifyGoogle: async () => ({ sub: "nobody", email: "n@example.test" }) },
  );
  app.use("/api", api.router);

  const db = new DatabaseSync(dbPath);
  for (const [subject, email, plan] of [
    ["paid-1", "paid@example.test", "pro"],
    ["free-1", "free@example.test", "free"],
    ["other-1", "other@example.test", "pro"],
  ]) {
    db.prepare(
      `INSERT INTO waitlist_signups
         (google_subject, email, waitlist_status, plan, approved_at)
       VALUES (?, ?, 'approved', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(subject, email, plan);
  }
  for (const [token, subject] of [
    [PAID_TOKEN, "paid-1"],
    [FREE_TOKEN, "free-1"],
    [OTHER_TOKEN, "other-1"],
  ]) {
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, ?, 'test', 'app', 'device-one')`,
    ).run(hashToken(token), subject);
  }
  db.close();

  t.after(() => {
    upstream.close();
    server.close();
    // The platform owns the sqlite handle; Windows will not unlink a file that
    // is still open, so it goes first and the retry covers the socket close.
    api.close?.();
    rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  });

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    dbPath,
    seen,
  };
}

function ask(origin, body, token = PAID_TOKEN, headers = {}) {
  return fetch(`${origin}/api/v1/images`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("a picture is made for the account that asked, with the server's key", async (t) => {
  const { origin, dbPath, seen } = await setup(t);

  const response = await ask(
    origin,
    { prompt: "a red panda astronaut, studio lighting", aspect_ratio: "16:9", n: 2 },
    PAID_TOKEN,
    { "x-hook-chat-id": "c42" },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].b64_json, PNG_B64);
  assert.equal(payload.data[0].media_type, "image/png");
  assert.equal(payload.model, "meta/muse-image");

  // What the app asked for became the endpoint's own body, and the endpoint's
  // key never left this process.
  assert.deepEqual(seen.body, {
    model: "meta/muse-image",
    prompt: "a red panda astronaut, studio lighting",
    n: 2,
    response_format: "b64_json",
    aspect_ratio: "16:9",
  });
  assert.equal(seen.authorization, `Bearer ${UPSTREAM_KEY}`);

  // Usage is recorded per picture, against the account, under its own surface.
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(
      "SELECT surface, model, status, chat_id FROM usage_events WHERE google_subject = 'paid-1'",
    )
    .all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    surface: "image",
    model: "meta/muse-image",
    status: 200,
    chat_id: "c42",
  });
  db.close();
});

test("no token, no picture", async (t) => {
  const { origin, seen } = await setup(t);
  const response = await ask(origin, { prompt: "anything" }, null);
  assert.equal(response.status, 401);
  assert.equal(seen.body, undefined, "the endpoint must not be reached");
});

test("a deployment with no picture key says so instead of spending one", async (t) => {
  const { origin, seen } = await setup(t, { env: { OPENROUTER_API_KEY: "" } });
  const response = await ask(origin, { prompt: "anything" });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, "image_unavailable");
  assert.equal(seen.body, undefined);
});

test("a free account has a daily window, and it is counted in pictures", async (t) => {
  const { origin, dbPath, seen } = await setup(t);

  // Fill the window the way a day of them would, with the oldest one already
  // outside the 24 hours so it does not count.
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(
    `INSERT INTO usage_events
       (google_subject, surface, model, status, plan, created_at)
     VALUES ('free-1', 'image', 'meta/muse-image', 200, 'free', ?)`,
  );
  insert.run("2020-01-01T00:00:00.000Z");
  for (let index = 0; index < FREE_IMAGE_LIMIT; index += 1) {
    insert.run(new Date().toISOString());
  }
  assert.equal(imageQuotaUsed(db, "free-1"), FREE_IMAGE_LIMIT);
  db.close();

  const refused = await ask(origin, { prompt: "one too many" }, FREE_TOKEN);
  assert.equal(refused.status, 403);
  const payload = await refused.json();
  assert.equal(payload.error.code, "image_limit");
  assert.match(payload.error.message, /limited to \d+ a day/);
  assert.equal(seen.body, undefined, "a refused picture is never generated");

  // A paid account has no window at all.
  const paid = await ask(origin, { prompt: "still fine" }, PAID_TOKEN);
  assert.equal(paid.status, 200);

  // And the window is per account: another one is untouched.
  const other = await ask(origin, { prompt: "another account" }, OTHER_TOKEN);
  assert.equal(other.status, 200);
});

test("the request is cleaned up before it reaches the endpoint", async (t) => {
  const { origin, seen } = await setup(t);

  // `n` is clamped to what one picture call may ask for.
  await ask(origin, { prompt: "a cat", n: 99 });
  assert.equal(seen.body.n, 4);

  // A ratio that is not one is dropped rather than forwarded.
  await ask(origin, { prompt: "a cat", aspect_ratio: "very wide" });
  assert.equal(seen.body.aspect_ratio, undefined);

  const empty = await ask(origin, { prompt: "   " });
  assert.equal(empty.status, 400);

  const tooLong = await ask(origin, { prompt: "x".repeat(4001) });
  assert.equal(tooLong.status, 400);

  // A refused upstream is the server's problem, not a credential the user can
  // fix: the endpoint's own message never reaches them.
  seen.fail = 401;
  const unauthorised = await ask(origin, { prompt: "a cat" });
  assert.equal(unauthorised.status, 502);
  const payload = await unauthorised.json();
  assert.equal(payload.error.code, "upstream_auth");
  assert.ok(!JSON.stringify(payload).includes(UPSTREAM_KEY));
});
