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

const secret = "hook-platform-test-secret-with-at-least-32-characters";
const clientId = "hook-platform.apps.googleusercontent.com";

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

  const api = createPlatform({
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
  });
  app.use("/api", api.router);

  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO waitlist_signups
       (google_subject, email, name, waitlist_status, approved_at)
     VALUES (?, ?, ?, 'approved', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run("approved-1", "approved@example.test", "Approved Person");
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
    await t.test("the app receives one token, and that token identifies the user", async () => {
      const polled = await request("/auth/device/poll", {
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

    await t.test("an approved session can see and download the installer", async () => {
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

      const denied = await request("/download/info", { cookie: waitingCookie });
      assert.equal(denied.status, 403);
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
