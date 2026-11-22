import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { WebSocket } from "ws";
import { createPlatform } from "./platform.mjs";
import { createRelay } from "./relay.mjs";
import { hashToken } from "./tokens.mjs";

const HOST_TOKEN = "hk_host_token_0123456789abcdefghij";
const HOST2_TOKEN = "hk_host2_token_0123456789abcdefghij";
const PHONE_TOKEN = "hk_phone_token_0123456789abcdefghij";
const TABLET_TOKEN = "hk_tablet_token_0123456789abcdefghij";
const WORKSPACE_TOKEN = "hk_workspace_token_0123456789abcdefgh";
const OTHER_TOKEN = "hk_other_token_0123456789abcdefghij";
const FREE_TOKEN = "hk_relay_free_token_0123456789abcdefgh";
const SYNC_OFF_TOKEN = "hk_relay_off_token_0123456789abcdefgh";

function hello(id, overrides = {}) {
  return {
    v: 1,
    kind: "hello",
    device: {
      id,
      name: "Ben's PC",
      kind: "desktop",
      platform: "windows",
      arch: "x86_64",
      appVersion: "0.4.0",
      product: "chat",
      role: "host",
      canHost: true,
      capabilities: { codingAgents: true, projects: true },
      specs: { cpuCores: 16, projects: 3 },
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
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      const index = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.frames.push(frame);
      }
    });
    ws.on("close", () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("closed"));
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
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error("timed out waiting for a frame"));
      }, timeout);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  /** Frames that arrive within `ms`; used to prove something did not arrive. */
  async quiet(ms = 120) {
    await new Promise((done) => setTimeout(done, ms));
    return this.frames.splice(0);
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise((done) => {
      this.ws.once("close", done);
      this.ws.close();
    });
  }
}

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "hook-relay-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const api = createPlatform({
    WAITLIST_ORIGIN: origin,
    WAITLIST_DB_PATH: dbPath,
    GOOGLE_CLIENT_ID: "hook-relay.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    WAITLIST_SESSION_SECRET: "s".repeat(48),
    GIT_ROOT: join(directory, "git"),
    SYNC_ROOT: join(directory, "sync"),
  });
  app.use("/api", api.router);
  const relay = createRelay({ server, db: api.db, presence: api.presence });

  const db = new DatabaseSync(dbPath);
  const accounts = [
    ["relay-pro", "pro", 1],
    ["relay-free", "free", 1],
    ["relay-off", "pro", 0],
    ["relay-other", "pro", 1],
  ];
  for (const [subject, plan, cloudSync] of accounts) {
    db.prepare(
      `INSERT INTO waitlist_signups
         (google_subject, email, waitlist_status, plan, cloud_sync, approved_at)
       VALUES (?, ?, 'approved', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(subject, `${subject}@example.test`, plan, cloudSync);
  }
  for (const [token, subject, device] of [
    [HOST_TOKEN, "relay-pro", "device-host"],
    [HOST2_TOKEN, "relay-pro", "device-host2"],
    [PHONE_TOKEN, "relay-pro", "device-phone"],
    [TABLET_TOKEN, "relay-pro", "device-tablet"],
    [WORKSPACE_TOKEN, "relay-pro", "device-workspace"],
    [OTHER_TOKEN, "relay-other", "device-other"],
    [FREE_TOKEN, "relay-free", "device-free"],
    [SYNC_OFF_TOKEN, "relay-off", "device-off"],
  ]) {
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, ?, 'test', 'app', ?)`,
    ).run(hashToken(token), subject, device);
  }
  db.close();

  const clients = [];
  async function connect(token, device, { expectStatus } = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-hook-device": device,
      },
    });
    if (expectStatus) {
      const status = await new Promise((resolve, reject) => {
        ws.once("open", () => reject(new Error("connection was accepted")));
        ws.once("unexpected-response", (_request, response) => {
          resolve(response.statusCode);
        });
        ws.once("error", () => {});
      });
      ws.terminate();
      return status;
    }
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("unexpected-response", (_request, response) =>
        reject(new Error(`refused with ${response.statusCode}`)),
      );
      ws.once("error", reject);
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
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  }

  t.after(async () => {
    for (const client of clients) await client.close();
    relay.close();
    await new Promise((done) => server.close(done));
    api.close();
    rmSync(directory, { recursive: true, force: true });
  });

  return { port, origin, request, connect };
}

test("a free account and a sync-off account cannot see or join the relay", async (t) => {
  const { request, connect } = await setup(t);
  assert.equal((await request("/devices", { token: FREE_TOKEN })).status, 403);
  assert.equal((await request("/devices", { token: SYNC_OFF_TOKEN })).status, 403);
  assert.equal(await connect(FREE_TOKEN, "device-free", { expectStatus: true }), 403);
  assert.equal(await connect(SYNC_OFF_TOKEN, "device-off", { expectStatus: true }), 403);
});

test("a host and a phone appear in presence, and a rename sticks", async (t) => {
  const { request, connect } = await setup(t);
  const host = await connect(HOST_TOKEN, "device-host");
  host.send(hello("device-host"));
  const ready = await host.next((frame) => frame.kind === "ready");
  assert.equal(ready.device.name, "Ben's PC");
  assert.equal(ready.device.role, "host");

  const phone = await connect(PHONE_TOKEN, "device-phone");
  phone.send(
    hello("device-phone", {
      name: "Ben's iPhone",
      kind: "mobile",
      platform: "android",
      arch: "aarch64",
      product: "mobile",
      role: "controller",
      canHost: false,
      capabilities: { codingAgents: false, remoteAgents: true },
      specs: null,
    }),
  );
  await phone.next((frame) => frame.kind === "ready");

  const presence = await host.next(
    (frame) =>
      frame.kind === "presence" &&
      frame.devices.some((device) => device.id === "device-phone"),
  );
  const names = new Map(presence.devices.map((device) => [device.id, device]));
  assert.equal(names.get("device-host").hostOnline, true);
  assert.equal(names.get("device-phone").hostOnline, false);
  assert.equal(names.get("device-phone").role, "controller");

  const listed = await request("/devices");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.devices.length, 2);
  assert.equal(listed.body.devices.find((d) => d.id === "device-phone").name, "Ben's iPhone");

  const renamed = await request("/devices/device-host", {
    method: "PATCH",
    body: { name: "Office PC" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.device.name, "Office PC");
  const update = await phone.next(
    (frame) =>
      frame.kind === "presence" &&
      frame.devices.some((device) => device.name === "Office PC"),
  );
  assert.ok(update);

  // A reconnect with the device's original name does not undo the rename.
  await host.close();
  const again = await connect(HOST_TOKEN, "device-host");
  again.send(hello("device-host", { name: "Ben's PC" }));
  await again.next((frame) => frame.kind === "ready");
  const after = await request("/devices");
  assert.equal(after.body.devices.find((d) => d.id === "device-host").name, "Office PC");
});

test("Workspace is a controller even when it claims host", async (t) => {
  const { request, connect } = await setup(t);
  const workspace = await connect(WORKSPACE_TOKEN, "device-workspace");
  workspace.send(
    hello("device-workspace", {
      name: "Ben's PC",
      product: "workspace",
      role: "host",
      canHost: true,
    }),
  );
  const ready = await workspace.next((frame) => frame.kind === "ready");
  assert.equal(ready.device.role, "controller");
  assert.equal(ready.device.hostOnline, false);
  const listed = await request("/devices", { token: WORKSPACE_TOKEN });
  assert.equal(listed.body.devices[0].canHost, false);
});

test("an RPC reaches the target machine and only its caller sees the answer", async (t) => {
  const { request, connect } = await setup(t);
  const host = await connect(HOST_TOKEN, "device-host");
  host.send(hello("device-host"));
  await host.next((frame) => frame.kind === "ready");

  const phone = await connect(PHONE_TOKEN, "device-phone");
  phone.send(hello("device-phone", { name: "Phone", kind: "mobile", product: "mobile", role: "controller", canHost: false }));
  await phone.next((frame) => frame.kind === "ready");

  const tablet = await connect(TABLET_TOKEN, "device-tablet");
  tablet.send(hello("device-tablet", { name: "Tablet", kind: "mobile", product: "mobile", role: "controller", canHost: false }));
  await tablet.next((frame) => frame.kind === "ready");

  phone.send({
    kind: "rpc",
    id: "rpc-1",
    to: "device-host",
    method: "agent.status",
    params: { agentId: "ag_1" },
  });
  const call = await host.next((frame) => frame.kind === "rpc");
  assert.equal(call.from, "device-phone");
  assert.equal(call.method, "agent.status");
  assert.equal(call.params.agentId, "ag_1");

  host.send({
    kind: "rpcResult",
    id: "rpc-1",
    ok: true,
    result: { state: "running", plan: [] },
  });
  const answer = await phone.next((frame) => frame.kind === "rpcResult");
  assert.equal(answer.ok, true);
  assert.equal(answer.result.state, "running");
  assert.equal((await tablet.quiet()).filter((frame) => frame.kind === "rpcResult").length, 0);

  // A machine that is known but not connected answers immediately, so the
  // caller can say "turn it on" instead of waiting a minute.
  const otherHost = await connect(HOST2_TOKEN, "device-host2");
  otherHost.send(hello("device-host2", { name: "Second PC" }));
  await otherHost.next((frame) => frame.kind === "ready");
  await otherHost.close();
  phone.send({ kind: "rpc", id: "rpc-2", to: "device-host2", method: "agent.list", params: {} });
  const offline = await phone.next(
    (frame) => frame.kind === "rpcResult" && frame.id === "rpc-2",
  );
  assert.equal(offline.ok, false);
  assert.equal(offline.error.code, "device_offline");

  // The switch on the machine itself is checked by the relay too.
  assert.equal(
    (
      await request("/devices/device-host", {
        method: "PATCH",
        body: { remoteAllowed: false },
      })
    ).status,
    200,
  );
  phone.send({ kind: "rpc", id: "rpc-3", to: "device-host", method: "agent.list", params: {} });
  const refused = await phone.next(
    (frame) => frame.kind === "rpcResult" && frame.id === "rpc-3",
  );
  assert.equal(refused.error.code, "remote_disabled");
});

test("a host publishes only to subscribers of that chat", async (t) => {
  const { connect } = await setup(t);
  const host = await connect(HOST_TOKEN, "device-host");
  host.send(hello("device-host"));
  await host.next((frame) => frame.kind === "ready");

  const phone = await connect(PHONE_TOKEN, "device-phone");
  phone.send(hello("device-phone", { name: "Phone", kind: "mobile", product: "mobile", role: "controller", canHost: false }));
  await phone.next((frame) => frame.kind === "ready");
  phone.send({ kind: "subscribe", chatId: "chat-1" });

  const tablet = await connect(TABLET_TOKEN, "device-tablet");
  tablet.send(hello("device-tablet", { name: "Tablet", kind: "mobile", product: "mobile", role: "controller", canHost: false }));
  await tablet.next((frame) => frame.kind === "ready");
  tablet.send({ kind: "subscribe", chatId: "chat-2" });

  host.send({
    kind: "publish",
    chatId: "chat-1",
    payload: { kind: "delta", text: "hello" },
  });
  const event = await phone.next((frame) => frame.kind === "event");
  assert.equal(event.chatId, "chat-1");
  assert.equal(event.payload.text, "hello");
  assert.equal((await tablet.quiet()).filter((frame) => frame.kind === "event").length, 0);

  // A controller cannot impersonate a machine and publish.
  phone.send({ kind: "publish", chatId: "chat-1", payload: { kind: "delta", text: "no" } });
  const error = await phone.next((frame) => frame.kind === "error");
  assert.equal(error.code, "not_a_host");
});

test("removing a machine closes it and revokes its credentials", async (t) => {
  const { request, connect } = await setup(t);
  const host = await connect(HOST_TOKEN, "device-host");
  host.send(hello("device-host"));
  await host.next((frame) => frame.kind === "ready");

  const phone = await connect(PHONE_TOKEN, "device-phone");
  phone.send(hello("device-phone", { name: "Phone", kind: "mobile", product: "mobile", role: "controller", canHost: false }));
  await phone.next((frame) => frame.kind === "ready");

  const stub = await request("/sync/remote-chats", {
    method: "POST",
    token: HOST_TOKEN,
    body: { chats: [{ id: "remote-host-chat", title: "Host work", updatedAt: 1 }] },
  });
  assert.equal(stub.status, 200);

  const removed = await request("/devices/device-host", { method: "DELETE" });
  assert.equal(removed.status, 204);
  const changes = await request("/sync/changes?since=0", { token: PHONE_TOKEN });
  const gone = changes.body.changes.find((entry) => entry.id === "remote-host-chat");
  assert.equal(gone.kind, "remoteChat");
  assert.equal(gone.deleted, true, "a removed machine's stubs become tombstones");
  await host.next((frame) => frame.kind === "presence" && !frame.devices.some((d) => d.id === "device-host"))
    .catch(() => {});
  const left = await request("/devices", { token: PHONE_TOKEN });
  assert.equal(left.body.devices.some((d) => d.id === "device-host"), false);
  assert.equal((await request("/devices", { token: HOST_TOKEN })).status, 401);
});
