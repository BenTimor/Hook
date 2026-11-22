import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { userKey } from "./git.mjs";
import { createPlatform } from "./platform.mjs";
import { hashToken } from "./tokens.mjs";

const APP_TOKEN = "hk_app_test_token_0123456789abcdefghij";
const SECOND_TOKEN = "hk_app_test_token_9876543210zyxwvutsrq";
const OTHER_TOKEN = "hk_app_test_token_other_0123456789abcdef";
const GIT_SCOPE_TOKEN = "hk_git_test_token_0123456789abcdefghij";
const FREE_TOKEN = "hk_free_test_token_0123456789abcdefghij";

function chat(id, { title = "New chat", updatedAt = 1000, messages = [] } = {}) {
  return {
    meta: {
      id,
      title,
      createdAt: 1000,
      updatedAt,
      pinned: false,
      pinnedAt: null,
      messageCount: 0,
      preview: "",
    },
    messages,
  };
}

function message(id, content, createdAt = 1000, status = "complete") {
  return { id, role: "assistant", content, createdAt, status };
}

async function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hook-sync-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = createPlatform({
    WAITLIST_ORIGIN: origin,
    WAITLIST_DB_PATH: dbPath,
    GOOGLE_CLIENT_ID: "hook-sync.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    WAITLIST_SESSION_SECRET: "s".repeat(48),
    GIT_ROOT: join(directory, "git"),
    SYNC_ROOT: join(directory, "sync"),
    ...overrides,
  });
  app.use("/api", api.router);

  const db = new DatabaseSync(dbPath);
  for (const [subject, email, plan] of [
    ["sync-a", "a@example.test", "pro"],
    ["sync-b", "b@example.test", "pro"],
    ["sync-free", "free@example.test", "free"],
  ]) {
    db.prepare(
      `INSERT INTO waitlist_signups
         (google_subject, email, waitlist_status, plan, approved_at)
       VALUES (?, ?, 'approved', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(subject, email, plan);
  }
  for (const [token, subject, device] of [
    [APP_TOKEN, "sync-a", "device-one"],
    [SECOND_TOKEN, "sync-a", "device-two"],
    [OTHER_TOKEN, "sync-b", "device-three"],
    [GIT_SCOPE_TOKEN, "sync-a", "device-one"],
    [FREE_TOKEN, "sync-free", "device-four"],
  ]) {
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, ?, 'test', ?, ?)`,
    ).run(hashToken(token), subject, token === GIT_SCOPE_TOKEN ? "git" : "app", device);
  }
  db.close();

  async function request(path, { method = "GET", token = APP_TOKEN, body, headers = {} } = {}) {
    const response = await fetch(`${origin}/api${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }

  t.after(async () => {
    await new Promise((done) => server.close(done));
    api.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, origin, request };
}

async function uploadMedia(origin, token, digest, bytes, type = "image/png") {
  return fetch(`${origin}/api/sync/media/${digest}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body: bytes,
  });
}

test("a chat pushed on one device is pulled unchanged on another", async (t) => {
  const { request } = await setup(t);
  const original = chat("chat-one", {
    title: "Invoice parser",
    messages: [message("m1", "hello", 1000)],
  });

  const pushed = await request("/sync/chats", {
    method: "POST",
    body: { chats: [original] },
  });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.results[0].chat.messages.length, 1);
  assert.ok(pushed.body.cursor > 0);

  const pulled = await request("/sync/changes?since=0");
  assert.equal(pulled.status, 200);
  const change = pulled.body.changes.find((entry) => entry.id === "chat-one");
  assert.equal(change.kind, "chat");
  assert.equal(change.chat.meta.title, "Invoice parser");
  assert.equal(change.chat.messages[0].content, "hello");

  // Pushing the same content again is a no-op, not a new revision.
  const again = await request("/sync/chats", {
    method: "POST",
    body: { chats: [original] },
  });
  assert.equal(again.body.results[0].unchanged, true);
  assert.equal(again.body.cursor, pushed.body.cursor);
});

test("concurrent devices merge messages by id instead of losing one", async (t) => {
  const { request } = await setup(t);
  const first = chat("chat-two", {
    title: "From device A",
    updatedAt: 2000,
    messages: [message("m1", "A wrote this", 1000)],
  });
  await request("/sync/chats", { method: "POST", body: { chats: [first] } });

  const second = chat("chat-two", {
    title: "From device B",
    updatedAt: 3000,
    messages: [
      message("m1", "A wrote this", 1000),
      message("m2", "B added this", 2500),
    ],
  });
  const merged = await request("/sync/chats", {
    method: "POST",
    token: SECOND_TOKEN,
    body: { chats: [second] },
  });
  assert.equal(merged.status, 200);
  const result = merged.body.results[0].chat;
  assert.deepEqual(
    result.messages.map((entry) => entry.id),
    ["m1", "m2"],
  );
  assert.equal(result.meta.title, "From device B");
  assert.equal(result.meta.messageCount, 2);
});

test("a merged chat keeps the order its messages were written in", async (t) => {
  const { request } = await setup(t);
  // Creation time is not transcript order: the memory frame is written at the
  // top of a chat although it is created after the question. Sorting by
  // `createdAt` used to move it between a tool call and its result, and the
  // model endpoint then refused every later message in the conversation.
  const frame = {
    id: "memory-chat-order",
    role: "system",
    content: "[memory rev 1]\nPinned.",
    createdAt: 2500,
    status: "complete",
    hidden: true,
    kind: "memory",
  };
  const call = {
    id: "m2",
    role: "assistant",
    content: "",
    createdAt: 2000,
    status: "complete",
    hidden: true,
    toolCalls: [{ id: "call_1", name: "workspace_tasks", arguments: "{}" }],
  };
  const tool = {
    id: "m3",
    role: "tool",
    content: "{\"tasks\":[]}",
    createdAt: 3000,
    status: "complete",
    hidden: true,
    toolCallId: "call_1",
  };
  await request("/sync/chats", {
    method: "POST",
    body: { chats: [chat("chat-order", { updatedAt: 2000, messages: [message("m1", "what tasks?", 1000)] })] },
  });

  const pushed = await request("/sync/chats", {
    method: "POST",
    token: SECOND_TOKEN,
    body: {
      chats: [
        chat("chat-order", {
          updatedAt: 3000,
          messages: [frame, message("m1", "what tasks?", 1000), call, tool],
        }),
      ],
    },
  });
  assert.equal(pushed.status, 200);
  assert.deepEqual(
    pushed.body.results[0].chat.messages.map((entry) => entry.id),
    ["memory-chat-order", "m1", "m2", "m3"],
  );

  const pulled = await request("/sync/changes?since=0");
  const stored = pulled.body.changes.find((entry) => entry.id === "chat-order");
  assert.deepEqual(
    stored.chat.messages.map((entry) => entry.id),
    ["memory-chat-order", "m1", "m2", "m3"],
  );
});

test("a tool result stored after its call is put back beside it", async (t) => {
  const { request } = await setup(t);
  const frame = {
    id: "memory-chat-split",
    role: "system",
    content: "[memory rev 1]\nPinned.",
    createdAt: 2500,
    status: "complete",
    hidden: true,
    kind: "memory",
  };
  const call = {
    id: "m2",
    role: "assistant",
    content: "",
    createdAt: 2000,
    status: "complete",
    hidden: true,
    toolCalls: [{ id: "call_1", name: "workspace_tasks", arguments: "{}" }],
  };
  const tool = {
    id: "m3",
    role: "tool",
    content: "{\"tasks\":[]}",
    createdAt: 3000,
    status: "complete",
    hidden: true,
    toolCallId: "call_1",
  };
  // Exactly what the sorting merge left behind: the frame wedged in between.
  const pushed = await request("/sync/chats", {
    method: "POST",
    body: {
      chats: [
        chat("chat-split", {
          messages: [message("m1", "what tasks?", 1000), call, frame, tool],
        }),
      ],
    },
  });
  assert.equal(pushed.status, 200);
  assert.deepEqual(
    pushed.body.results[0].chat.messages.map((entry) => entry.id),
    ["m1", "m2", "m3", "memory-chat-split"],
  );
});

test("a message only the older copy has keeps its place in the merge", async (t) => {
  const { request } = await setup(t);
  await request("/sync/chats", {
    method: "POST",
    body: {
      chats: [
        chat("chat-splice", {
          updatedAt: 3000,
          messages: [
            message("m1", "one", 1000),
            message("m2", "two", 2000),
            message("m3", "three", 3000),
          ],
        }),
      ],
    },
  });

  // A device that was offline still has a message between m1 and m2.
  const stale = await request("/sync/chats", {
    method: "POST",
    token: SECOND_TOKEN,
    body: {
      chats: [
        chat("chat-splice", {
          updatedAt: 1500,
          messages: [message("m1", "one", 1000), message("m1b", "between", 1500)],
        }),
      ],
    },
  });
  assert.equal(stale.status, 200);
  assert.deepEqual(
    stale.body.results[0].chat.messages.map((entry) => entry.id),
    ["m1", "m1b", "m2", "m3"],
  );
});

test("a finished message beats a stale streaming snapshot", async (t) => {
  const { request } = await setup(t);
  await request("/sync/chats", {
    method: "POST",
    body: {
      chats: [chat("chat-stream", { messages: [message("m1", "partial", 1000, "streaming")] })],
    },
  });
  const finished = await request("/sync/chats", {
    method: "POST",
    token: SECOND_TOKEN,
    body: {
      chats: [
        chat("chat-stream", {
          updatedAt: 5000,
          messages: [message("m1", "the full answer", 1000, "complete")],
        }),
      ],
    },
  });
  assert.equal(finished.body.results[0].chat.messages[0].content, "the full answer");
});

test("deletions are tombstones and an explicit restore revives the chat", async (t) => {
  const { request } = await setup(t);
  await request("/sync/chats", {
    method: "POST",
    body: { chats: [chat("chat-three", { messages: [message("m1", "keep me")] })] },
  });

  const deleted = await request("/sync/chats", {
    method: "POST",
    token: SECOND_TOKEN,
    body: { chats: [{ id: "chat-three", deleted: true, updatedAt: 9000 }] },
  });
  assert.equal(deleted.body.results[0].deleted, true);

  // A stale device pushes the old copy: the tombstone still wins.
  const stale = await request("/sync/chats", {
    method: "POST",
    body: { chats: [chat("chat-three", { messages: [message("m1", "keep me")] })] },
  });
  assert.equal(stale.body.results[0].deleted, true);

  const restored = await request("/sync/chats", {
    method: "POST",
    body: {
      chats: [
        { ...chat("chat-three", { messages: [message("m1", "keep me")] }), restored: true },
      ],
    },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.results[0].deleted, false);
  assert.equal(restored.body.results[0].chat.messages[0].content, "keep me");
});

test("projects sync their identity and provision a bare repository", async (t) => {
  const { request, directory } = await setup(t);
  const created = await request("/sync/projects", {
    method: "POST",
    body: {
      projects: [
        {
          id: "pj_invoiceparser",
          name: "invoice-parser",
          description: "Reads invoices",
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.results[0].ok, true);
  const repo = join(directory, "git", userKey("sync-a"), "pj_invoiceparser.git");
  assert.ok(existsSync(join(repo, "HEAD")));

  const duplicate = await request("/sync/projects", {
    method: "POST",
    body: {
      projects: [
        {
          id: "pj_other",
          name: "Invoice-Parser",
          description: "collides case-insensitively",
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    },
  });
  assert.equal(duplicate.body.results[0].ok, false);
  assert.equal(duplicate.body.results[0].error, "duplicate_name");

  const changes = await request("/sync/changes?since=0");
  const project = changes.body.changes.find((entry) => entry.id === "pj_invoiceparser");
  assert.equal(project.kind, "project");
  assert.equal(project.description, "Reads invoices");
});

test("media uploads round-trip and stay private", async (t) => {
  const { origin } = await setup(t);
  const bytes = Buffer.from("image bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");

  const uploaded = await uploadMedia(origin, APP_TOKEN, digest, bytes);
  assert.equal(uploaded.status, 200);

  const downloaded = await fetch(`${origin}/api/sync/media/${digest}`, {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);

  const other = await fetch(`${origin}/api/sync/media/${digest}`, {
    headers: { authorization: `Bearer ${OTHER_TOKEN}` },
  });
  assert.equal(other.status, 404);

  const wrong = await uploadMedia(origin, APP_TOKEN, "f".repeat(64), bytes);
  assert.equal(wrong.status, 400);
});

test("tokens are scoped: git tokens cannot read chats and app tokens mint git tokens", async (t) => {
  const { request } = await setup(t);
  const syncWithGit = await request("/sync/status", { token: GIT_SCOPE_TOKEN });
  assert.equal(syncWithGit.status, 401);

  const minted = await request("/auth/git-token", {
    method: "POST",
    body: { label: "test device" },
    headers: { "x-hook-device": "device-test" },
  });
  assert.equal(minted.status, 200);
  assert.match(minted.body.token, /^hk_git_[A-Za-z0-9_-]{32,}$/);

  const syncWithApp = await request("/sync/status");
  assert.equal(syncWithApp.status, 200);
});

test("quota rejections roll the whole batch back", async (t) => {
  const { request } = await setup(t, { SYNC_CHAT_MAX_BYTES: 2048 });
  const tooBig = chat("chat-big", {
    messages: [message("m1", "x".repeat(4096))],
  });
  const response = await request("/sync/chats", {
    method: "POST",
    body: { chats: [chat("chat-small", { messages: [message("m1", "ok")] }), tooBig] },
  });
  assert.equal(response.status, 413);
  const changes = await request("/sync/changes?since=0");
  assert.equal(changes.body.changes.length, 0);
});

function memory(id, { text = "Prefers pnpm.", pinned = true, updatedAt = 1000, deleted = false } = {}) {
  return {
    id,
    text,
    kind: "user",
    pinned,
    chatId: null,
    createdAt: 1000,
    updatedAt,
    deleted,
  };
}

test("memory entries sync to the other device and keep the newest version", async (t) => {
  const { request } = await setup(t);
  const pushed = await request("/sync/memory", {
    method: "POST",
    body: { entries: [memory("mem-1", { text: "Prefers pnpm.", updatedAt: 2000 })] },
  });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.entries[0].ok, true);

  const pulled = await request("/sync/changes?since=0");
  const change = pulled.body.changes.find((entry) => entry.id === "mem-1");
  assert.equal(change.kind, "memory");
  assert.equal(change.entry.text, "Prefers pnpm.");
  assert.equal(change.entry.pinned, true);
  assert.equal(change.entry.kind, "user");

  // The same fact again is a no-op, not a new revision.
  const again = await request("/sync/memory", {
    method: "POST",
    body: { entries: [memory("mem-1", { text: "Prefers pnpm.", updatedAt: 2000 })] },
  });
  assert.equal(again.body.entries[0].unchanged, true);
  assert.equal(again.body.cursor, pushed.body.cursor);

  // A stale push from the other device never wins.
  const stale = await request("/sync/memory", {
    method: "POST",
    body: { entries: [memory("mem-1", { text: "Prefers yarn.", updatedAt: 1000 })] },
  });
  assert.equal(stale.body.entries[0].unchanged, true);
  const latest = await request("/sync/changes?since=0");
  const entries = latest.body.changes.filter((entry) => entry.id === "mem-1");
  assert.equal(entries[entries.length - 1].entry.text, "Prefers pnpm.");
});

test("a forgotten memory arrives as a tombstone", async (t) => {
  const { request } = await setup(t);
  await request("/sync/memory", {
    method: "POST",
    body: { entries: [memory("mem-2", { updatedAt: 1000 })] },
  });
  const removed = await request("/sync/memory", {
    method: "POST",
    body: { entries: [memory("mem-2", { text: "", updatedAt: 2000, deleted: true })] },
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.entries[0].deleted, true);

  const pulled = await request("/sync/changes?since=0");
  const change = pulled.body.changes.find((entry) => entry.id === "mem-2");
  assert.equal(change.deleted, true);
  assert.equal(change.entry.deleted, true);

  const status = await request("/sync/status");
  assert.equal(status.body.memory, 0, "a tombstone is not a live memory");
});

test("memory rejects an entry that is not shaped like one", async (t) => {
  const { request } = await setup(t);
  const response = await request("/sync/memory", {
    method: "POST",
    body: { entries: [{ id: "has spaces", text: "nope" }] },
  });
  assert.equal(response.status, 400);
  const pulled = await request("/sync/changes?since=0");
  assert.equal(pulled.body.changes.length, 0);
});

test("a free account never syncs, but can still delete what is stored", async (t) => {
  const { request } = await setup(t);
  const status = await request("/sync/status", { token: FREE_TOKEN });
  assert.equal(status.status, 403);
  assert.equal(status.body.error.code, "sync_not_included");

  const push = await request("/sync/chats", {
    method: "POST",
    token: FREE_TOKEN,
    body: { chats: [chat("free-chat")] },
  });
  assert.equal(push.status, 403);
  assert.equal(push.body.error.code, "sync_not_included");

  // Deleting data is always allowed: an account that went free must be able to
  // take its old cloud copy with it.
  const removed = await request("/sync/account", { method: "DELETE", token: FREE_TOKEN });
  assert.equal(removed.status, 200);
});

test("deleting the account clears chats, projects, memory and media", async (t) => {
  const { request } = await setup(t);
  await request("/sync/chats", { method: "POST", body: { chats: [chat("chat-gone")] } });
  await request("/sync/memory", {
    method: "POST",
    body: { entries: [memory("mem-gone", { text: "Prefers pnpm." })] },
  });
  const removed = await request("/sync/account", { method: "DELETE" });
  assert.equal(removed.status, 200);
  const changes = await request("/sync/changes?since=0");
  assert.equal(changes.body.changes.length, 0);
  const status = await request("/sync/status");
  assert.equal(status.body.chats, 0);
  assert.equal(status.body.projects, 0);
  assert.equal(status.body.memory, 0);
});
