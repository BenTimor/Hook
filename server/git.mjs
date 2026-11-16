/**
 * Hook's private git service.
 *
 * Every project folder on a user's machine is backed by one bare repository
 * here, addressed as `/api/git/<projectId>.git`. The desktop app injects the
 * token in an `Authorization` header, so no URL, password or credential helper
 * is ever written into a project.
 *
 * The transport is `git http-backend`, the same program that serves git over
 * HTTP everywhere else: it understands packfiles, shallow fetches, protocol
 * v2 and push negotiation, and it is the part of git least worth rewriting.
 *
 * Storage lives on the same persisted volume as SQLite:
 *
 *   /data/git/<hashed account>/<projectId>.git
 *
 * A pre-receive hook (git-policy.mjs) rejects pushes that would exceed the
 * per-project or per-account size limits, before anything is written.
 */

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Router } from "express";
import { gitUser } from "./tokens.mjs";

const run = promisify(execFile);

const POLICY = fileURLToPath(new URL("./git-policy.mjs", import.meta.url));
const HOOK_VERSION = "1";
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RATE_LIMIT = 240;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export function gitRoot(env = {}) {
  return resolve(env.GIT_ROOT || "waitlist-data/git");
}

function gitBinary(env = {}) {
  return env.GIT_BIN || process.env.HOOK_GIT_BIN || "git";
}

/** Storage limits. Read from env so tests can exercise the hooks cheaply. */
function limits(env = {}) {
  return {
    push: Number(env.GIT_MAX_PUSH_BYTES) || 50 * 1024 * 1024,
    repo: Number(env.GIT_REPO_MAX_BYTES) || 200 * 1024 * 1024,
    user: Number(env.GIT_USER_MAX_BYTES) || 1024 * 1024 * 1024,
    repos: Number(env.GIT_MAX_REPOS) || 250,
  };
}

/** Stable, non-identifying folder for one account's repositories. */
export function userKey(subject) {
  return createHash("sha256").update(String(subject)).digest("hex").slice(0, 24);
}

export function repoPath(env, subject, repoId) {
  return join(gitRoot(env), userKey(subject), `${repoId}.git`);
}

function gitEnv(env, subject) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HOOK_SYNC_SUBJECT: subject,
    HOOK_GIT_BIN: gitBinary(env),
    HOOK_REPO_MAX_BYTES: String(limits(env).repo),
    HOOK_USER_MAX_BYTES: String(limits(env).user),
  };
}

async function git(env, subject, args) {
  return run(gitBinary(env), args, {
    env: gitEnv(env, subject),
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function writeHook(repo) {
  const hooksDir = join(repo, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, "pre-receive");
  const body = `#!/bin/sh\nexec "${process.execPath}" "${POLICY}"\n`;
  writeFileSync(hook, body, { mode: 0o755 });
  try {
    chmodSync(hook, 0o755);
  } catch {
    /* Windows or a read-only mount: git will report the hook as unusable */
  }
  writeFileSync(join(repo, "hook-version"), HOOK_VERSION);
}

const ready = new Map();
const hookChecked = new Set();
const lastGc = new Map();

/**
 * Create the bare repository the first time a device, the sync API or a push
 * touches it. Safe under concurrent requests: the promise is memoized per path.
 */
export function ensureRepo(env, subject, repoId) {
  if (!REPO_ID.test(repoId)) return Promise.reject(new Error("Invalid project id"));
  const repo = repoPath(env, subject, repoId);
  if (ready.has(repo)) return ready.get(repo);

  const task = (async () => {
    const owner = dirname(repo);
    if (!existsSync(repo)) {
      mkdirSync(owner, { recursive: true, mode: 0o700 });
      let count = 0;
      try {
        count = readdirSync(owner, { withFileTypes: true }).filter(
          (entry) => entry.isDirectory() && entry.name.endsWith(".git"),
        ).length;
      } catch {
        /* a fresh folder */
      }
      if (count >= limits(env).repos)
        throw new Error("This account has reached its project limit.");
      await git(env, subject, ["init", "--bare", "-b", "main", repo]);
    }
    if (!hookChecked.has(repo)) {
      let version = "";
      try {
        version = readFileSync(join(repo, "hook-version"), "utf8").trim();
      } catch {
        /* not installed yet */
      }
      if (version !== HOOK_VERSION) await writeHook(repo);
      const settings = [
        ["http.receivepack", "true"],
        ["receive.denyDeletes", "true"],
        ["receive.maxInputSize", String(limits(env).push)],
        ["core.logAllRefUpdates", "true"],
        ["gc.auto", "0"],
      ];
      for (const [key, value] of settings)
        await git(env, subject, ["--git-dir", repo, "config", key, value]);
      hookChecked.add(repo);
    }
    return repo;
  })();

  ready.set(repo, task);
  task.catch(() => ready.delete(repo));
  return task;
}

/** Drop memoized state for one account (used when its data is deleted). */
export function forgetUser(env, subject) {
  const owner = dirname(repoPath(env, subject, "x"));
  for (const key of ready.keys()) if (key.startsWith(owner)) ready.delete(key);
  for (const key of hookChecked) if (key.startsWith(owner)) hookChecked.delete(key);
  for (const key of lastGc.keys()) if (key.startsWith(owner)) lastGc.delete(key);
}

/** After a successful push, let git compact in the background at most hourly. */
function maybeGc(env, subject, repo) {
  const now = Date.now();
  const last = lastGc.get(repo) ?? 0;
  if (now - last < 60 * 60 * 1000) return;
  lastGc.set(repo, now);
  const child = spawn(gitBinary(env), ["--git-dir", repo, "gc", "--auto", "--quiet"], {
    env: gitEnv(env, subject),
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
}

function rateLimit() {
  const windows = new Map();
  return function allow(subject) {
    const now = Date.now();
    const entry = windows.get(subject);
    if (!entry || now - entry.at > RATE_WINDOW_MS) {
      windows.set(subject, { at: now, count: 1 });
      return true;
    }
    entry.count += 1;
    if (windows.size > 10_000) windows.clear();
    return entry.count <= RATE_LIMIT;
  };
}

function authError(res, result) {
  res.status(result.status).json({
    error: {
      message: result.message,
      type: "invalid_request_error",
      code: result.code,
    },
  });
}

/** CGI reply from `git http-backend`: headers block, then the raw body. */
function reply(req, res, env, subject, repo, pathInfo, allow) {
  return new Promise((done) => {
    const child = spawn(gitBinary(env), ["http-backend"], {
      env: {
        ...gitEnv(env, subject),
        GIT_PROJECT_ROOT: dirname(repo),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        REQUEST_METHOD: req.method,
        QUERY_STRING: req.url.split("?")[1] ?? "",
        REMOTE_USER: subject,
        REMOTE_ADDR: req.ip ?? "127.0.0.1",
        ...(req.get("content-type") ? { CONTENT_TYPE: req.get("content-type") } : {}),
        ...(req.get("content-length") ? { CONTENT_LENGTH: req.get("content-length") } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let buffered = Buffer.alloc(0);
    let headersDone = false;
    let sentStatus = 200;
    let stderr = "";

    const fail = (status, message) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.status(status).json({ error: { message, type: "git_error" } });
      }
      done();
    };

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout.on("data", (chunk) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      let separator = buffered.indexOf("\r\n\r\n");
      let length = 4;
      if (separator < 0) {
        separator = buffered.indexOf("\n\n");
        length = 2;
      }
      if (separator < 0) return;

      const head = buffered.slice(0, separator).toString("utf8");
      const rest = buffered.slice(separator + length);
      const headers = {};
      for (const line of head.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") {
          const code = Number(value.split(" ")[0]);
          if (Number.isInteger(code)) sentStatus = code;
        } else {
          headers[key] = value;
        }
      }
      res.status(sentStatus);
      for (const [key, value] of Object.entries(headers)) res.set(key, value);
      if (rest.length) res.write(rest);
      headersDone = true;
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT")
        fail(503, "The git service is not installed on this server.");
      else fail(502, "The git service could not be started.");
    });

    child.on("close", (code) => {
      if (!headersDone) {
        if (code === 0) fail(502, "The git service returned no response.");
        else if (stderr.trim())
          fail(400, stderr.trim().split("\n").slice(-1)[0].slice(0, 300));
        else fail(502, "The git service failed.");
        return;
      }
      res.end();
      if (req.method === "POST" && pathInfo.endsWith("/git-receive-pack") && code === 0)
        maybeGc(env, subject, repo);
      done();
    });

    req.on("aborted", () => {
      child.kill();
      done();
    });

    req.pipe(child.stdin);
    child.stdin.on("error", () => {
      /* the client disappeared mid-push; close handles the rest */
    });
  });
}

export function createGitRouter({ env, db }) {
  const router = Router();
  const allow = rateLimit();

  // Everything under /git, parsed here so the route syntax stays independent
  // of Express' path matcher. `/git/<projectId>.git/...` only.
  router.use(async (req, res, next) => {
    const raw = req.url.split("?")[0];
    const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.git(\/.*)?$/.exec(raw);
    if (!match) return next();
    if (raw.includes("\0") || /(^|\/)\.\.(\/|$)/.test(raw)) {
      res.status(400).json({ error: { message: "Invalid repository path." } });
      return;
    }
    const repoId = match[1];
    const rest = match[2] ?? "";

    const result = gitUser(db, req);
    if (!result.row) return authError(res, result);
    const subject = result.row.google_subject;
    if (!allow(subject)) {
      res.status(429).json({
        error: { message: "Too many git operations. Try again in a minute." },
      });
      return;
    }

    try {
      const repo = await ensureRepo(env, subject, repoId);
      await reply(req, res, env, subject, repo, `/${repoId}.git${rest}`);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      res.status(500).json({
        error: { message: error.message || "The git service failed." },
      });
    }
  });

  return router;
}
