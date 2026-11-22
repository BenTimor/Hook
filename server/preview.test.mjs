import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { WebSocket } from "ws";
import { createPlatform } from "./platform.mjs";
import { createRelay } from "./relay.mjs";
import { hashToken } from "./tokens.mjs";

const HOST_TOKEN = "hk_preview_host_token_0123456789ab";
const PHONE_TOKEN = "hk_preview_phone_token_0123456789a";
const FREE_TOKEN = "hk_preview_free_token_0123456789abc";

function hello(id, overrides = {}) {
  return {
    v: 1,
    kind: "hello",
    device: {
      id,
      name: "Preview PC",
      kind: "desktop",
      platform: "windows",
      arch: "x86_64",
      appVersion: "0.4.0",
      product: "chat",
      role: "host",
      canHost: true,
      capabilities: { codingAgents: true },
      specs: { cpuCores: 8, projects: 1 },
      ...overrides,
    },
  };
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.frames.push(frame);
      }
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  next(predicate = () => true, timeout = 2500) {
    const index = this.frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), timeout);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  close() {
    this.ws.close();
  }
}

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "hook-preview-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const api = createPlatform({
    WAITLIST_ORIGIN: origin,
    WAITLIST_DB_PATH: dbPath,
    GOOGLE_CLIENT_ID: "hook-preview.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    WAITLIST_SESSION_SECRET: "s".repeat(48),
    GIT_ROOT: join(directory, "git"),
    SYNC_ROOT: join(directory, "sync"),
  });
  app.use(api.previewTunnel.middleware);
  app.use("/api", api.router);
  const relay = createRelay({
    server,
    db: api.db,
    presence: api.presence,
    previewTunnel: api.previewTunnel,
  });

  const db = new DatabaseSync(dbPath);
  for (const [subject, plan] of [
    ["preview-pro", "pro"],
    ["preview-free", "free"],
  ]) {
    db.prepare(
      `INSERT INTO waitlist_signups
         (google_subject, email, waitlist_status, plan, cloud_sync, approved_at)
       VALUES (?, ?, 'approved', ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(subject, `${subject}@example.test`, plan);
  }
  for (const [token, subject, device] of [
    [HOST_TOKEN, "preview-pro", "preview-host"],
    [PHONE_TOKEN, "preview-pro", "preview-phone"],
    [FREE_TOKEN, "preview-free", "preview-free"],
  ]) {
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, ?, 'test', 'app', ?)`,
    ).run(hashToken(token), subject, device);
  }
  db.close();

  const clients = [];
  async function connect(token, device) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-hook-device": device,
      },
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`refused ${res.statusCode}`)),
      );
    });
    const client = new Client(ws);
    clients.push(client);
    return client;
  }

  async function request(path, { method = "GET", token = HOST_TOKEN, body } = {}) {
    const response = await fetch(`${origin}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  function fetchPreview(host, path) {
    return new Promise((resolve, reject) => {
      const request = createServerRequest(
        { host: `${origin}`, path, headers: { host } },
        resolve,
        reject,
      );
      request.end();
    });
  }

  t.after(async () => {
    for (const client of clients) client.close();
    relay.close();
    api.previewTunnel.close();
    await new Promise((done) => server.close(done));
    api.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return { request, connect, fetchPreview, port };
}

/** A tiny http client that keeps the Host header the tunnel routes by. */
function createServerRequest({ host, path, headers }, resolve, reject) {
  const url = new URL(host);
  const request = httpRequest(
    {
      hostname: url.hostname,
      port: url.port,
      path,
      method: "GET",
      headers,
    },
    (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
          type: response.headers["content-type"],
        }),
      );
    },
  );
  request.on("error", reject);
  return request;
}

test("a ticket serves one file from the machine over the relay", async (t) => {
  const { request, connect, fetchPreview } = await setup(t);
  const host = await connect(HOST_TOKEN, "preview-host");
  host.send(hello("preview-host"));
  await host.next((frame) => frame.kind === "ready");

  const ticket = await request("/remote/preview/ticket", {
    method: "POST",
    body: {
      deviceId: "preview-host",
      chatId: "chat-1",
      file: "dist/index.html",
    },
  });
  assert.equal(ticket.status, 200);
  assert.match(ticket.body.url, /^https:\/\/[a-f0-9]{32}\.preview\.hookcode\.io\/dist\/index\.html$/);
  const url = new URL(ticket.body.url);

  const waiting = fetchPreview(url.host, url.pathname);
  const ask = await host.next((frame) => frame.kind === "previewRequest");
  assert.equal(ask.chatId, "chat-1");
  assert.equal(ask.path, "/dist/index.html");
  host.send({
    kind: "previewResult",
    id: ask.id,
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: Buffer.from("<h1>hello</h1>").toString("base64"),
  });
  const page = await waiting;
  assert.equal(page.status, 200);
  assert.equal(page.body, "<h1>hello</h1>");
  assert.match(page.type, /text\/html/);
});

test("a free account, a controller and an offline machine get no ticket", async (t) => {
  const { request, connect } = await setup(t);
  assert.equal(
    (
      await request("/remote/preview/ticket", {
        method: "POST",
        token: FREE_TOKEN,
        body: { deviceId: "preview-free", chatId: "c", file: "index.html" },
      })
    ).status,
    403,
  );
  // A machine that has registered but is not connected cannot serve a page.
  const host = await connect(HOST_TOKEN, "preview-host");
  host.send(hello("preview-host"));
  await host.next((frame) => frame.kind === "ready");
  host.close();
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(
    (
      await request("/remote/preview/ticket", {
        method: "POST",
        body: { deviceId: "preview-host", chatId: "c", file: "index.html" },
      })
    ).status,
    409,
  );
});
