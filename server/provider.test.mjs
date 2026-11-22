/**
 * The account-level preferences every product reads, and the personal model
 * endpoint a paid account syncs between its devices.
 *
 * The endpoint is a credential, so these tests also pin the storage rule: the
 * key is ciphertext at rest, it is absent from the metadata route, a free or
 * sync-off account is refused, a clear removes it everywhere, and a deployment
 * without `HOOK_PROVIDER_SECRET` stores nothing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import express from "express";
import { createPlatform } from "./platform.mjs";
import { hashToken } from "./tokens.mjs";

const APP_TOKEN = "hk_app_provider_token_0123456789abcdef";
const SECOND_TOKEN = "hk_app_provider_two_0123456789abcdefgh";
const FREE_TOKEN = "hk_free_provider_token_0123456789abcdef";
const OTHER_TOKEN = "hk_other_provider_token_0123456789abcdef";
const SECRET = "p".repeat(48);
const API_KEY = "sk-live-0123456789-not-a-real-key";

async function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hook-provider-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = createPlatform({
    WAITLIST_ORIGIN: origin,
    WAITLIST_DB_PATH: dbPath,
    GOOGLE_CLIENT_ID: "hook-provider.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    WAITLIST_SESSION_SECRET: "s".repeat(48),
    HOOK_PROVIDER_SECRET: SECRET,
    ...overrides,
  });
  app.use("/api", api.router);

  const db = new DatabaseSync(dbPath);
  for (const [subject, email, plan, cloudSync] of [
    ["provider-a", "a@example.test", "pro", 1],
    ["provider-b", "b@example.test", "pro", 0],
    ["provider-free", "free@example.test", "free", 1],
  ]) {
    db.prepare(
      `INSERT INTO waitlist_signups
         (google_subject, email, waitlist_status, plan, cloud_sync, approved_at)
       VALUES (?, ?, 'approved', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(subject, email, plan, cloudSync);
  }
  for (const [token, subject] of [
    [APP_TOKEN, "provider-a"],
    [SECOND_TOKEN, "provider-a"],
    [FREE_TOKEN, "provider-free"],
    [OTHER_TOKEN, "provider-b"],
  ]) {
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, ?, 'test', 'app', 'device-one')`,
    ).run(hashToken(token), subject);
  }
  db.close();

  async function request(path, { method = "GET", token = APP_TOKEN, body } = {}) {
    const response = await fetch(`${origin}/api${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }

  /** The raw rows, so a test can assert what a database leak would contain. */
  function query(sql, ...params) {
    const read = new DatabaseSync(dbPath);
    const value = /^\s*select/i.test(sql)
      ? read.prepare(sql).all(...params)
      : read.prepare(sql).run(...params);
    read.close();
    return value;
  }

  t.after(async () => {
    await new Promise((done) => server.close(done));
    api.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, origin, request, query };
}

function save(updatedAt, apiKey = API_KEY, model = "gpt-4o-mini") {
  return {
    updatedAt,
    provider: { baseUrl: "https://api.example.test/v1", apiKey, model },
  };
}

test("an endpoint saved on one device reaches another without the key in metadata", async (t) => {
  const { request, query } = await setup(t);
  const saved = await request("/provider", {
    method: "PUT",
    body: {
      updatedAt: 1000,
      provider: {
        baseUrl: " https://api.example.test/v1/ ",
        apiKey: API_KEY,
        model: "gpt-4o-mini",
      },
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.provider.baseUrl, "https://api.example.test/v1");
  assert.equal(saved.body.provider.model, "gpt-4o-mini");
  assert.equal(saved.body.provider.hasKey, true);

  // The other device sees what it needs and never the secret itself.
  const meta = await request("/provider", { token: SECOND_TOKEN });
  assert.equal(meta.status, 200);
  assert.equal(meta.headers.get("cache-control"), "no-store");
  assert.equal(meta.body.provider.baseUrl, "https://api.example.test/v1");
  assert.equal(meta.body.provider.hasKey, true);
  assert.equal(meta.body.provider.apiKey, undefined);
  assert.ok(!JSON.stringify(meta.body).includes(API_KEY));

  const secret = await request("/provider/secret", { token: SECOND_TOKEN });
  assert.equal(secret.status, 200);
  assert.equal(secret.headers.get("cache-control"), "no-store");
  assert.equal(secret.body.provider.apiKey, API_KEY);

  // At rest the key is ciphertext, and no column carries it.
  const [row] = query("SELECT * FROM account_provider");
  assert.ok(row.key_cipher);
  assert.notEqual(row.key_cipher, API_KEY);
  for (const column of Object.values(row)) {
    assert.ok(!String(column).includes(API_KEY), "no column may hold the key");
  }

  // Editing the endpoint without the key keeps the stored one, which is what a
  // window that never reads the secret back sends.
  const edited = await request("/provider", {
    method: "PUT",
    body: save(2000, "", "gpt-4o"),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.provider.model, "gpt-4o");
  const kept = await request("/provider/secret");
  assert.equal(kept.body.provider.apiKey, API_KEY);
});

test("the endpoint is refused for a free account and for sync turned off", async (t) => {
  const { request } = await setup(t);
  for (const token of [FREE_TOKEN, OTHER_TOKEN]) {
    const read = await request("/provider", { token });
    assert.equal(read.status, 403);
    assert.equal(
      read.body.error.code,
      token === FREE_TOKEN ? "sync_not_included" : "sync_disabled",
    );
    const write = await request("/provider", {
      method: "PUT",
      token,
      body: save(1000),
    });
    assert.equal(write.status, 403);
    const secret = await request("/provider/secret", { token });
    assert.equal(secret.status, 403);
  }
});

test("an older push loses, and a clear reaches every device", async (t) => {
  const { request, query } = await setup(t);
  assert.equal((await request("/provider", { method: "PUT", body: save(2000, API_KEY, "newest") })).status, 200);

  const stale = await request("/provider", {
    method: "PUT",
    token: SECOND_TOKEN,
    body: save(1000, "sk-old", "old"),
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.unchanged, true);
  assert.equal(stale.body.provider.model, "newest");

  const cleared = await request("/provider", {
    method: "PUT",
    token: SECOND_TOKEN,
    body: { updatedAt: 3000, provider: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.provider, null);
  assert.equal((await request("/provider")).body.provider, null);
  assert.equal((await request("/provider/secret")).body.provider, null);

  // The tombstone emptied the secret; nothing lingers in the row.
  const [row] = query("SELECT * FROM account_provider");
  assert.equal(row.deleted, 1);
  assert.equal(row.key_cipher, "");
  assert.equal(row.key_iv, "");
  assert.equal(row.key_tag, "");
  assert.equal(row.base_url, "");

  // A device that had not seen the clear cannot resurrect the old endpoint.
  const resurrect = await request("/provider", { method: "PUT", body: save(2500) });
  assert.equal(resurrect.body.unchanged, true);
  assert.equal(resurrect.body.provider, null);
});

test("a ciphertext copied to another account cannot be read", async (t) => {
  const { request, query } = await setup(t);
  await request("/provider", { method: "PUT", body: save(1000) });
  const [row] = query("SELECT * FROM account_provider");

  // The subject is the GCM additional data, so a row moved between accounts is
  // exactly what this produces. Give the other account sync so the route runs.
  query("UPDATE waitlist_signups SET cloud_sync = 1 WHERE google_subject = 'provider-b'");
  query(
    `INSERT INTO account_provider
       (google_subject, base_url, model, key_cipher, key_iv, key_tag, updated_at, deleted)
     VALUES ('provider-b', ?, ?, ?, ?, ?, 1000, 0)`,
    row.base_url,
    row.model,
    row.key_cipher,
    row.key_iv,
    row.key_tag,
  );

  const stolen = await request("/provider/secret", { token: OTHER_TOKEN });
  assert.equal(stolen.status, 503);
  assert.equal(stolen.body.error.code, "provider_unreadable");
  assert.ok(!JSON.stringify(stolen.body).includes(API_KEY));
});

test("without a deployment secret the service refuses to store a key", async (t) => {
  const { request, query } = await setup(t, { HOOK_PROVIDER_SECRET: "" });
  const refused = await request("/provider", { method: "PUT", body: save(1000) });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, "provider_sync_unavailable");
  assert.equal(query("SELECT * FROM account_provider").length, 0);
});

test("a body that forgets the provider does not count as a clear", async (t) => {
  const { request } = await setup(t);
  await request("/provider", { method: "PUT", body: save(1000) });
  const bad = await request("/provider", { method: "PUT", body: { updatedAt: 2000 } });
  assert.equal(bad.status, 400);
  // The stored endpoint is untouched, so a malformed request cannot delete a key.
  const kept = await request("/provider");
  assert.equal(kept.body.provider.model, "gpt-4o-mini");
  assert.equal(kept.body.updatedAt, 1000);
});

test("advanced mode is an account preference, cloud sync stays paid", async (t) => {
  const { request } = await setup(t);

  // A free account may turn the display preference on: it is a boolean, not
  // content, and the phone must be able to follow the desktop.
  const free = await request("/auth/preferences", {
    method: "POST",
    token: FREE_TOKEN,
    body: { advancedMode: true },
  });
  assert.equal(free.status, 200);
  assert.equal(free.body.user.advancedMode, true);
  assert.equal(free.body.user.cloudSync, true);

  const me = await request("/auth/me", { token: FREE_TOKEN });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.advancedMode, true);

  const off = await request("/auth/preferences", {
    method: "POST",
    token: FREE_TOKEN,
    body: { advancedMode: false },
  });
  assert.equal(off.body.user.advancedMode, false);

  // The sync switch still belongs to a paid plan.
  const paidOnly = await request("/auth/preferences", {
    method: "POST",
    token: FREE_TOKEN,
    body: { cloudSync: false },
  });
  assert.equal(paidOnly.status, 403);
  assert.equal(paidOnly.body.error.code, "sync_not_included");

  // A paid account may flip the switch, and the endpoint route follows it.
  const paid = await request("/auth/preferences", {
    method: "POST",
    body: { cloudSync: false },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.user.cloudSync, false);
  const provider = await request("/provider");
  assert.equal(provider.status, 403);
  assert.equal(provider.body.error.code, "sync_disabled");

  // The body is validated rather than half-applied.
  for (const body of [{}, { advancedMode: "yes" }, { unknown: true }]) {
    const bad = await request("/auth/preferences", { method: "POST", body });
    assert.equal(bad.status, 400);
  }
});

test("an account that never set advanced mode reports null", async (t) => {
  const { request } = await setup(t);
  const me = await request("/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.user.advancedMode, null);
});
