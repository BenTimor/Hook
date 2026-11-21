import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { createPlatform } from "./platform.mjs";
import { hashToken } from "./tokens.mjs";

const secret = "hook-platform-test-secret-with-at-least-32-characters";
const clientId = "hook-platform.apps.googleusercontent.com";

// What the phone's account sheet would hand back. The verifier below looks a
// token up here instead of asking Google; ids must be long enough to pass the
// endpoint's shape check on the raw token.
const googleToken = (name) => `${name}.${"x".repeat(140)}`;
const googleAccounts = new Map([
  [
    googleToken("approved"),
    { sub: "approved-1", email: "approved@example.test", email_verified: true },
  ],
  [
    googleToken("waiting"),
    { sub: "waiting-1", email: "waiting@example.test", email_verified: true },
  ],
  [
    googleToken("unverified"),
    { sub: "approved-1", email: "approved@example.test", email_verified: false },
  ],
  [
    googleToken("stranger"),
    { sub: "nobody-1", email: "nobody@example.test", email_verified: true },
  ],
]);

function receiptFor(subject) {
  const payload = Buffer.from(
    JSON.stringify({ joined: true, subject, expires: Date.now() + 60_000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `hook_joined=${payload}.${signature}`;
}

test("approved users can sign in a device, use the proxy, see usage, download and be revoked", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hook-platform-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const releases = join(directory, "releases");
  mkdirSync(releases, { recursive: true });
  writeFileSync(join(releases, "Hook-setup.exe"), Buffer.from("fake-installer"));
  writeFileSync(
    join(directory, "release.config.json"),
    JSON.stringify({
      minimumVersion: "1.0.0",
      store: {
        productId: "9NX9J93HP25M",
        latest: "1.2.3",
        minimumVersion: "1.0.0",
      },
    }),
  );
  writeFileSync(
    join(releases, "latest.json"),
    JSON.stringify({
      version: "1.2.3",
      commit: "abc1234",
      builtAt: "2026-01-01T00:00:00.000Z",
      sha256: "f".repeat(64),
      size: 14,
    }),
  );

  const upstreamApp = express();
  upstreamApp.use(express.json({ limit: "1mb" }));
  let sawUpstream = null;
  let sawSearch = null;
  let upstreamMode = "stream";
  upstreamApp.post("/v1/tools/search", (req, res) => {
    sawSearch = req.body;
    res.json({
      results: [
        {
          title: "Hook docs",
          url: "https://example.com/hook",
          snippet: "Hook is a desktop AI chat app.",
          summary: "Hook connects chat and coding agents to an approved model relay.",
          site_name: "Example",
          date: "2026-11-15T00:00:00+00:00",
          authority: 3,
          rerank_score: 2.4,
        },
      ],
    });
  });
  upstreamApp.post("/chat/completions", (req, res) => {
    sawUpstream = req.body;
    if (upstreamMode === "auth") {
      res.status(401).json({ error: { message: "invalid upstream key" } });
      return;
    }
    res.status(200);
    res.set({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const upstream = createServer(upstreamApp);
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  const upstreamPort = upstream.address().port;

  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const api = createPlatform(
    {
      WAITLIST_ORIGIN: origin,
      WAITLIST_DB_PATH: dbPath,
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: "fixture",
      WAITLIST_SESSION_SECRET: secret,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      DEEPSEEK_API_KEY: "upstream-secret",
      DEEPSEEK_MODEL: "deepseek-flash",
      HOOK_MODEL_ID: "hook",
      DOWNLOAD_DIR: releases,
      RELEASE_CONFIG: join(directory, "release.config.json"),
    },
    {
      // Checking a real ID token means fetching Google's certificates; the
      // suite never leaves the machine, so the verifier is a lookup table.
      verifyGoogle: async (idToken, audience) => {
        assert.equal(audience, clientId);
        const account = googleAccounts.get(idToken);
        if (!account) throw new Error("invalid token");
        return account;
      },
    },
  );
  app.use("/api", api.router);

  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO waitlist_signups
       (google_subject, email, name, waitlist_status, plan, approved_at)
     VALUES (?, ?, ?, 'approved', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run("approved-1", "approved@example.test", "Approved Person", "pro");
  // A free account: the same sign-in, a different entitlement.
  db.prepare(
    `INSERT INTO waitlist_signups
       (google_subject, email, name, waitlist_status, plan, approved_at)
     VALUES (?, ?, ?, 'approved', 'free', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run("free-1", "free@example.test", "Free Person");
  const freeToken = "hk_free_test_token_0123456789abcdefghij";
  db.prepare(
    `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
     VALUES (?, 'free-1', 'test', 'app', 'device-free')`,
  ).run(hashToken(freeToken));
  db.prepare(
    `INSERT INTO waitlist_signups
       (google_subject, email, name, waitlist_status)
     VALUES (?, ?, ?, 'waitlisted')`,
  ).run("waiting-1", "waiting@example.test", "Waiting Person");

  const approvedCookie = receiptFor("approved-1");
  const waitingCookie = receiptFor("waiting-1");

  async function request(path, { method = "GET", body, cookie, token, headers = {} } = {}) {
    return fetch(`${origin}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function startDevice() {
    const response = await request("/auth/device/start", { method: "POST", body: {} });
    assert.equal(response.status, 200);
    return response.json();
  }

  try {
    await t.test("an unapproved account cannot approve a device", async () => {
      const device = await startDevice();
      const response = await request("/auth/device/approve", {
        method: "POST",
        cookie: waitingCookie,
        headers: { origin },
        body: { userCode: device.userCode },
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "not_approved");
      const polled = await request("/auth/device/poll", {
        method: "POST",
        body: { deviceCode: device.deviceCode },
      });
      assert.equal((await polled.json()).status, "pending");
    });

    const device = await startDevice();
    await t.test("start returns a short code and a browser URL that carries it", () => {
      assert.match(device.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.match(device.deviceCode, /^[A-Za-z0-9_-]{40,}$/);
      const url = new URL(device.verificationUrl);
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, "/authorize");
      assert.equal(url.searchParams.get("code"), device.userCode);
      assert.equal(device.interval, 2);
    });

    await t.test("poll stays pending until the signed-in user approves", async () => {
      const pending = await request("/auth/device/poll", {
        method: "POST",
        body: { deviceCode: device.deviceCode },
      });
      assert.deepEqual(await pending.json(), { status: "pending" });

      const approved = await request("/auth/device/approve", {
        method: "POST",
        cookie: approvedCookie,
        headers: { origin },
        body: { userCode: device.userCode.toLowerCase() },
      });
      assert.equal(approved.status, 200);
      assert.equal((await approved.json()).approved, true);
    });

    let token = "";
    await t.test("the app receives one token, and that token identifies the user", async () => {      const polled = await request("/auth/device/poll", {
        method: "POST",
        body: { deviceCode: device.deviceCode },
      });
      const payload = await polled.json();
      assert.equal(payload.status, "approved");
      assert.match(payload.token, /^hk_[A-Za-z0-9_-]{40,}$/);
      assert.equal(payload.user.email, "approved@example.test");
      token = payload.token;

      const again = await request("/auth/device/poll", {
        method: "POST",
        body: { deviceCode: device.deviceCode },
      });
      assert.deepEqual(await again.json(), { status: "claimed" });

      const me = await request("/auth/me", { token });
      const mePayload = await me.json();
      assert.equal(mePayload.authenticated, true);
      assert.equal(mePayload.user.subject, "approved-1");
      assert.equal(mePayload.user.plan, "pro");
      assert.equal(mePayload.user.cloudSync, true);
      // A paid account has no message quota to draw.
      assert.equal(mePayload.quota, null);
    });

    await t.test("the waitlist itself grants no plan", () => {
      // A row that is only on the waitlist stores no entitlement, even though
      // `planOf()` would answer `free` defensively for an approved row.
      const waiting = db
        .prepare("SELECT plan FROM waitlist_signups WHERE google_subject = 'waiting-1'")
        .get();
      assert.equal(waiting.plan, null);
    });

    await t.test("a phone asks which Google client to use, without a session", async () => {
      const response = await request("/auth/config");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { googleClientId: clientId });
    });

    await t.test("a native Google token signs an approved account in", async () => {
      const response = await request("/auth/google", {
        method: "POST",
        body: { idToken: googleToken("approved") },
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.match(payload.token, /^hk_[A-Za-z0-9_-]{40,}$/);
      assert.equal(payload.user.email, "approved@example.test");

      // The same token the device flow would have produced: the rest of the
      // API cannot tell which door the account came in by.
      const me = await request("/auth/me", { token: payload.token });
      assert.equal(me.status, 200);
      const row = db
        .prepare(
          "SELECT label, scope FROM api_tokens WHERE google_subject = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get("approved-1");
      assert.equal(row.label, "Hook mobile");
      assert.equal(row.scope, "app");
    });

    await t.test("native sign-in refuses anything but a verified approved account", async () => {
      const waiting = await request("/auth/google", {
        method: "POST",
        body: { idToken: googleToken("waiting") },
      });
      assert.equal(waiting.status, 403);
      assert.equal((await waiting.json()).error, "not_approved");

      const stranger = await request("/auth/google", {
        method: "POST",
        body: { idToken: googleToken("stranger") },
      });
      assert.equal(stranger.status, 403);

      // Google said the address was not verified: no account, whatever the row.
      const unverified = await request("/auth/google", {
        method: "POST",
        body: { idToken: googleToken("unverified") },
      });
      assert.equal(unverified.status, 401);

      const forged = await request("/auth/google", {
        method: "POST",
        body: { idToken: googleToken("forged") },
      });
      assert.equal(forged.status, 401);
      assert.equal((await forged.json()).error, "invalid_token");
    });

    await t.test("native sign-in rejects a token that is not a token", async () => {
      const short = await request("/auth/google", {
        method: "POST",
        body: { idToken: "x" },
      });
      assert.equal(short.status, 400);
      const missing = await request("/auth/google", { method: "POST", body: {} });
      assert.equal(missing.status, 400);
    });

    await t.test("the models endpoint describes the one proxied model", async () => {
      const response = await request("/v1/models", { token });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.data[0].id, "hook");
      assert.deepEqual(payload.data[0].input_modalities, ["text", "image"]);
    });

    await t.test("the web search tool uses DeepSeek's standalone search API", async () => {
      const response = await request("/v1/search", {
        method: "POST",
        token,
        body: { query: "Hook desktop app", count: 3 },
        headers: {
          "x-hook-surface": "coding",
          "x-hook-chat-id": "chat_1",
          "x-hook-agent-id": "ag_1",
        },
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.query, "Hook desktop app");
      assert.equal(payload.results[0].title, "Hook docs");
      assert.equal(sawSearch.query, "Hook desktop app");
      assert.equal(sawSearch.count, 3);
    });

    await t.test("the proxy relays the stream and records per-chat/agent usage", async () => {
      const response = await request("/v1/chat/completions", {
        method: "POST",
        token,
        body: {
          model: "ignored-by-proxy",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
        headers: {
          "x-hook-chat-id": "chat_1",
          "x-hook-agent-id": "ag_1",
          "x-hook-surface": "coding",
        },
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /Hello/);
      assert.match(text, /world/);
      assert.match(text, /"prompt_cache_hit_tokens":80/);

      assert.equal(sawUpstream.model, "deepseek-flash");
      assert.equal(sawUpstream.stream, true);
      assert.equal(sawUpstream.stream_options.include_usage, true);

      const usage = db
        .prepare(
          `SELECT * FROM usage_events
           WHERE google_subject = 'approved-1' ORDER BY id DESC LIMIT 1`,
        )
        .get();
      assert.equal(usage.chat_id, "chat_1");
      assert.equal(usage.agent_id, "ag_1");
      assert.equal(usage.surface, "coding");
      assert.equal(usage.prompt_tokens, 100);
      assert.equal(usage.completion_tokens, 7);
      assert.equal(usage.cache_hit_tokens, 80);
      assert.equal(usage.cache_miss_tokens, 20);
      assert.equal(usage.reasoning_tokens, 2);
      assert.equal(usage.status, 200);
    });

    await t.test("a free account is metered, has no coding agents and cannot sync", async () => {
      const seed = db.prepare(
        `INSERT INTO usage_events (google_subject, surface, status, message_id, plan)
         VALUES ('free-1', 'chat', 200, ?, 'free')`,
      );
      for (let i = 0; i < 100; i += 1) seed.run(`free-message-${i}`);

      const metered = await request("/v1/chat/completions", {
        method: "POST",
        token: freeToken,
        body: { messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(metered.status, 429);
      assert.equal((await metered.json()).error.code, "message_limit");

      // Checked before the quota, because a free account has no coding agents
      // at all, not even 100 messages' worth.
      const coding = await request("/v1/chat/completions", {
        method: "POST",
        token: freeToken,
        body: { messages: [{ role: "user", content: "hi" }] },
        headers: { "x-hook-surface": "coding" },
      });
      assert.equal(coding.status, 403);
      assert.equal((await coding.json()).error.code, "coding_not_included");

      const sync = await request("/sync/status", { token: freeToken });
      assert.equal(sync.status, 403);
      assert.equal((await sync.json()).error.code, "sync_not_included");

      // Search is not a conversation and is not metered.
      const search = await request("/v1/search", {
        method: "POST",
        token: freeToken,
        body: { query: "hook" },
      });
      assert.equal(search.status, 200);

      const view = await (await request("/auth/me", { token: freeToken })).json();
      assert.equal(view.user.plan, "free");
      assert.equal(view.quota.limit, 100);
      assert.equal(view.quota.used, 100);
      assert.equal(view.quota.remaining, 0);
      assert.ok(view.quota.resetAt);

      // A free account may not turn sync on.
      const refused = await request("/auth/preferences", {
        method: "POST",
        token: freeToken,
        body: { cloudSync: true },
      });
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, "sync_not_included");

      // The window rolls: the very same rows, aged past a day, stop counting.
      db.prepare(
        `UPDATE usage_events
            SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')
          WHERE google_subject = 'free-1'`,
      ).run();
      const freed = await request("/v1/chat/completions", {
        method: "POST",
        token: freeToken,
        body: { messages: [{ role: "user", content: "again" }] },
      });
      assert.equal(freed.status, 200);
      await freed.text();
      const afterWindow = await (
        await request("/auth/me", { token: freeToken })
      ).json();
      assert.equal(afterWindow.quota.used, 0);
      assert.equal(afterWindow.quota.remaining, 100);
    });

    await t.test("a paid account can switch cloud sync off for every product", async () => {
      const off = await request("/auth/preferences", {
        method: "POST",
        token,
        body: { cloudSync: false },
      });
      assert.equal(off.status, 200);
      assert.equal((await off.json()).user.cloudSync, false);

      const status = await request("/sync/status", { token });
      assert.equal(status.status, 403);
      assert.equal((await status.json()).error.code, "sync_disabled");

      // Account state, not product state: a second product's token reads it too.
      const me = await (await request("/auth/me", { token })).json();
      assert.equal(me.user.cloudSync, false);

      const on = await request("/auth/preferences", {
        method: "POST",
        token,
        body: { cloudSync: true },
      });
      assert.equal((await on.json()).user.cloudSync, true);
    });

    await t.test("the app can report what the proxy cannot see, and only that", async () => {
      const ok = await request("/events", {
        method: "POST",
        token: freeToken,
        body: { kind: "byok_saved", product: "chat" },
        headers: { "x-hook-app-version": "1.2.3" },
      });
      assert.equal(ok.status, 204);
      const row = db
        .prepare("SELECT * FROM client_events ORDER BY id DESC LIMIT 1")
        .get();
      assert.equal(row.kind, "byok_saved");
      assert.equal(row.plan, "free");
      assert.equal(row.product, "chat");
      assert.equal(row.app_version, "1.2.3");

      const bad = await request("/events", {
        method: "POST",
        token: freeToken,
        body: { kind: "the user's message was ..." },
      });
      assert.equal(bad.status, 400);
    });

    await t.test("the release index is public and names the supported floor", async () => {
      const response = await request("/releases");
      assert.equal(response.status, 200);
      const index = await response.json();
      assert.equal(index.latest, "1.2.3");
      assert.equal(index.minimum, "1.0.0");
      assert.deepEqual(index.store, { latest: "1.2.3", minimum: "1.0.0" });
      assert.equal(index.releases[0].version, "1.2.3");
      // The merge tool needs the file name to preserve history; it is not a
      // secret, only the download itself is gated.
      assert.equal(index.releases[0].file, "Hook-setup.exe");
      // The installer URL stays behind the account gate even though the
      // version list does not.
      assert.equal(index.releases[0].url, "/api/download/windows");
    });

    await t.test("an approved session installs from the Store and can still fetch the installer", async () => {
      const status = await request("/waitlist/status", {
        cookie: approvedCookie,
      });
      assert.equal(status.status, 200);
      // The website installs through the Store, never through an installer.
      assert.deepEqual((await status.json()).store, {
        productId: "9NX9J93HP25M",
        url: "ms-windows-store://pdp/?productid=9NX9J93HP25M",
      });

      const waiting = await request("/waitlist/status", {
        cookie: waitingCookie,
      });
      assert.equal(waiting.status, 200);
      assert.equal((await waiting.json()).store, undefined);

      const info = await request("/download/info", { cookie: approvedCookie });
      assert.equal(info.status, 200);
      const manifest = await info.json();
      assert.equal(manifest.available, true);
      assert.equal(manifest.version, "1.2.3");

      const download = await request("/download/windows", { cookie: approvedCookie });
      assert.equal(download.status, 200);
      assert.match(
        download.headers.get("content-disposition") || "",
        /attachment; filename="?Hook-setup.exe"?/,
      );
      assert.deepEqual(
        Buffer.from(await download.arrayBuffer()),
        Buffer.from("fake-installer"),
      );

      const pinned = await request("/download/windows?version=1.2.3", {
        cookie: approvedCookie,
      });
      assert.equal(pinned.status, 200);

      const unknown = await request("/download/windows?version=9.9.9", {
        cookie: approvedCookie,
      });
      assert.equal(unknown.status, 404);
      assert.equal((await unknown.json()).error.code, "unknown_version");

      const denied = await request("/download/info", { cookie: waitingCookie });
      assert.equal(denied.status, 403);
    });

    await t.test("an approved user can report AI output, with the conversation if opted in", async () => {
      const transcript = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "inappropriate reply" },
      ];
      const response = await request("/reports", {
        method: "POST",
        token,
        body: {
          chatId: "chat_1",
          messageId: "msg_1",
          reason: "harmful",
          note: "This is not acceptable.",
          content: "inappropriate reply",
          transcript,
          appVersion: "0.1.2",
        },
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { ok: true });

      const report = db
        .prepare("SELECT * FROM ai_reports ORDER BY id DESC LIMIT 1")
        .get();
      assert.equal(report.google_subject, "approved-1");
      assert.equal(report.chat_id, "chat_1");
      assert.equal(report.reason, "harmful");
      assert.equal(report.content, "inappropriate reply");
      assert.equal(report.transcript, JSON.stringify(transcript));
      assert.equal(report.app_version, "0.1.2");
      assert.equal(report.status, "open");
    });

    await t.test("a report without the transcript stores only the reported reply", async () => {
      const response = await request("/reports", {
        method: "POST",
        token,
        body: {
          chatId: "chat_1",
          messageId: "msg_2",
          reason: "other",
          content: "another reply",
        },
      });
      assert.equal(response.status, 201);
      const report = db
        .prepare("SELECT * FROM ai_reports ORDER BY id DESC LIMIT 1")
        .get();
      assert.equal(report.transcript, null);
      assert.equal(report.note, null);
    });

    await t.test("a person's words can be reported through a preview", async () => {
      const response = await request("/reports", {
        method: "POST",
        token,
        body: {
          chatId: "chat_1",
          target: {
            kind: "task",
            id: "task_9",
            projectId: "prj_1",
            title: "Fix the invoice run",
          },
          reason: "hate",
          note: "A comment on this task.",
          content: "Mallory: the words that were written",
        },
      });
      assert.equal(response.status, 201);

      const report = db
        .prepare("SELECT * FROM ai_reports ORDER BY id DESC LIMIT 1")
        .get();
      // One queue, two kinds: the row says which, and the entity id stands in
      // for a message id so a reviewer can find the task.
      assert.equal(report.subject_kind, "content");
      assert.equal(report.message_id, "task_9");
      assert.equal(report.transcript, null);
      assert.deepEqual(JSON.parse(report.target), {
        kind: "task",
        id: "task_9",
        title: "Fix the invoice run",
        projectId: "prj_1",
      });
    });

    await t.test("a content report must name a known entity and a title", async () => {
      const unknownKind = await request("/reports", {
        method: "POST",
        token,
        body: {
          chatId: "chat_1",
          target: { kind: "planet", id: "x", title: "x" },
          reason: "other",
          content: "something",
        },
      });
      assert.equal(unknownKind.status, 400);
      assert.equal((await unknownKind.json()).error, "invalid_target");

      const untitled = await request("/reports", {
        method: "POST",
        token,
        body: {
          chatId: "chat_1",
          target: { kind: "board", id: "board_2" },
          reason: "other",
          content: "something",
        },
      });
      assert.equal(untitled.status, 400);
    });

    await t.test("reports are rejected without an approved account or a valid reason", async () => {
      const anonymous = await request("/reports", {
        method: "POST",
        body: { reason: "harmful", content: "reply" },
      });
      assert.equal(anonymous.status, 401);

      const waiting = await request("/reports", {
        method: "POST",
        cookie: waitingCookie,
        body: { reason: "harmful", content: "reply" },
      });
      assert.equal(waiting.status, 403);

      const invalid = await request("/reports", {
        method: "POST",
        token,
        body: { reason: "not-a-reason", content: "reply" },
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, "invalid_reason");
    });

    await t.test("a bad server-side provider key is a 502, not a revoked client session", async () => {
      upstreamMode = "auth";
      const failed = await request("/v1/chat/completions", {
        method: "POST",
        token,
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(failed.status, 502);
      const payload = await failed.json();
      assert.equal(payload.error.code, "upstream_auth");
      const me = await request("/auth/me", { token });
      assert.equal(me.status, 200);
      upstreamMode = "stream";
    });

    await t.test("revoking the account stops the token on its next request", async () => {
      db.prepare(
        "UPDATE waitlist_signups SET waitlist_status = 'revoked' WHERE google_subject = 'approved-1'",
      ).run();

      const proxied = await request("/v1/chat/completions", {
        method: "POST",
        token,
        body: { messages: [{ role: "user", content: "still there?" }] },
      });
      assert.equal(proxied.status, 403);
      const error = await proxied.json();
      assert.equal(error.error.code, "not_approved");

      const me = await request("/auth/me", { token });
      assert.equal(me.status, 403);

      const search = await request("/v1/search", {
        method: "POST",
        token,
        body: { query: "still there?" },
      });
      assert.equal(search.status, 403);

      const download = await request("/download/windows", {
        cookie: approvedCookie,
      });
      assert.equal(download.status, 403);
    });

    await t.test("a missing or unknown token is rejected without touching the upstream", async () => {
      const missing = await request("/v1/chat/completions", {
        method: "POST",
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(missing.status, 401);
      const unknown = await request("/v1/chat/completions", {
        method: "POST",
        token: `hk_${"a".repeat(43)}`,
        body: { messages: [{ role: "user", content: "hello" }] },
      });
      assert.equal(unknown.status, 401);
    });
  } finally {
    db.close();
    await new Promise((done) => server.close(done));
    await new Promise((done) => upstream.close(done));
    api.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()))
      throw new Error("Unexpected test cleanup directory");
    rmSync(directory, { recursive: true, force: true });
  }
});
