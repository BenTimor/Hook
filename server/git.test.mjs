import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import express from "express";
import { hashToken } from "./tokens.mjs";
import { createPlatform } from "./platform.mjs";

const run = promisify(execFile);

const APP_TOKEN = "hk_app_git_test_0123456789abcdefghijkl";
const GIT_TOKEN = "hk_git_git_test_0123456789abcdefghijkl";

async function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hook-git-test-"));
  const dbPath = join(directory, "signups.sqlite");
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  const app = express();
  const server = createServer(app);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = createPlatform({
    WAITLIST_ORIGIN: origin,
    WAITLIST_DB_PATH: dbPath,
    GOOGLE_CLIENT_ID: "hook-git.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    WAITLIST_SESSION_SECRET: "g".repeat(48),
    GIT_ROOT: join(directory, "git"),
    SYNC_ROOT: join(directory, "sync"),
    ...overrides,
  });
  app.use("/api", api.router);

  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO waitlist_signups
       (google_subject, email, waitlist_status, approved_at)
     VALUES ('git-a', 'a@example.test', 'approved',
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run();
  for (const [token, scope] of [
    [APP_TOKEN, "app"],
    [GIT_TOKEN, "git"],
  ]) {
    db.prepare(
      `INSERT INTO api_tokens (token_hash, google_subject, label, scope, device_id)
       VALUES (?, 'git-a', 'test', ?, 'device-one')`,
    ).run(hashToken(token), scope);
  }
  db.close();

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Hook Test",
    GIT_AUTHOR_EMAIL: "hook@example.test",
    GIT_COMMITTER_NAME: "Hook Test",
    GIT_COMMITTER_EMAIL: "hook@example.test",
  };

  // Async on purpose: a synchronous git call would block this process' event
  // loop, and the API server this test talks to lives in the same process.
  async function git(cwd, args, token = GIT_TOKEN) {
    const auth = token
      ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`]
      : [];
    return run("git", [...auth, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  t.after(async () => {
    await new Promise((done) => server.close(done));
    api.close();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows keeps a killed git process' directory locked for a moment.
    }
  });
  return { directory, origin, git };
}

async function commit(git, cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  await git(cwd, ["add", file]);
  await git(cwd, ["commit", "-m", message]);
}

test("a coding agent can push and another device can clone the project", async (t) => {
  const { directory, origin, git } = await setup(t);
  const work = join(directory, "work");
  mkdirSync(work);
  await git(work, ["init", "-b", "main"]);
  await commit(git, work, "notes.txt", "from device A\n", "first");
  const url = `${origin}/api/git/pj_gitsync.git`;
  await git(work, ["remote", "add", "origin", url]);
  await git(work, ["push", "-u", "origin", "main"]);

  const clone = join(directory, "clone");
  await git(directory, ["clone", url, clone]);
  assert.equal(readFileSync(join(clone, "notes.txt"), "utf8"), "from device A\n");

  await commit(git, clone, "notes.txt", "from device B\n", "second");
  await git(clone, ["push", "origin", "main"]);

  await git(work, ["pull", "--rebase", "origin", "main"]);
  assert.equal(readFileSync(join(work, "notes.txt"), "utf8"), "from device B\n");
});

test("an app token cannot reach git, and a git token cannot reach chats", async (t) => {
  const { directory, origin, git } = await setup(t);
  const url = `${origin}/api/git/pj_scope.git`;

  // Check the refusal directly: git's own 401 path can wait on a credential
  // helper on Windows, which says nothing about the server.
  const denied = await fetch(`${origin}/api/git/pj_scope.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Bearer ${APP_TOKEN}` },
  });
  assert.equal(denied.status, 401);

  const status = await fetch(`${origin}/api/sync/status`, {
    headers: { authorization: `Bearer ${GIT_TOKEN}` },
  });
  assert.equal(status.status, 401);

  // The minted git token behaves like the fixture one for the git surface.
  const minted = await fetch(`${origin}/api/auth/git-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${APP_TOKEN}`,
      "content-type": "application/json",
      "x-hook-device": "device-one",
    },
    body: JSON.stringify({ label: "test device" }),
  });
  assert.equal(minted.status, 200);
  const { token } = await minted.json();
  await git(directory, ["clone", url, join(directory, "fresh")], token);
});

test("the pre-receive hook rejects a project over its storage limit", async (t) => {
  const { directory, origin, git } = await setup(t, { GIT_REPO_MAX_BYTES: 4096 });
  const work = join(directory, "work");
  mkdirSync(work);
  await git(work, ["init", "-b", "main"]);
  await commit(git, work, "small.txt", "ok\n", "first");
  const url = `${origin}/api/git/pj_quota.git`;
  await git(work, ["remote", "add", "origin", url]);
  await git(work, ["push", "-u", "origin", "main"]);

  writeFileSync(join(work, "big.bin"), Buffer.alloc(16 * 1024, 7));
  await git(work, ["add", "big.bin"]);
  await git(work, ["commit", "-m", "too big"]);
  await assert.rejects(git(work, ["push", "origin", "main"]), (error) => {
    assert.match(String(error.stderr), /Hook: this project is/);
    return true;
  });
});

test("deleting a branch on the account's repository is refused", async (t) => {
  const { directory, origin, git } = await setup(t);
  const work = join(directory, "work");
  mkdirSync(work);
  await git(work, ["init", "-b", "main"]);
  await commit(git, work, "a.txt", "a\n", "first");
  const url = `${origin}/api/git/pj_delete.git`;
  await git(work, ["remote", "add", "origin", url]);
  await git(work, ["push", "-u", "origin", "main"]);

  await assert.rejects(git(work, ["push", "origin", "--delete", "main"]));
});
