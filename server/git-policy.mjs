#!/usr/bin/env node
/**
 * Pre-receive policy for Hook's private project repositories.
 *
 * Runs inside git's quarantine before a push is accepted, so a rejected push
 * leaves the repository exactly as it was. Two limits are enforced:
 *
 *   HOOK_REPO_MAX_BYTES   one project (default 200 MB)
 *   HOOK_USER_MAX_BYTES   everything the account stores in git (default 1 GB)
 *
 * The message lands on the coding agent's stderr ("remote: ..."), so it has to
 * say what to do in one line, not just quote a byte count.
 *
 * Plain Node with built-ins only: it is copied next to no dependencies.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO_MAX = Number(process.env.HOOK_REPO_MAX_BYTES) || 200 * 1024 * 1024;
const USER_MAX = Number(process.env.HOOK_USER_MAX_BYTES) || 1024 * 1024 * 1024;
const GIT = process.env.HOOK_GIT_BIN || "git";

const gitDir = process.env.GIT_DIR;
const subject = process.env.HOOK_SYNC_SUBJECT;

function git(args) {
  return execFileSync(GIT, ["--git-dir", gitDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function existingRepoBytes() {
  try {
    const output = git(["count-objects", "-v"]);
    let kib = 0;
    for (const line of output.split("\n")) {
      const [key, value] = line.trim().split(":");
      if (key === "size" || key === "size-pack") kib += Number(value) || 0;
    }
    return kib * 1024;
  } catch {
    return 0;
  }
}

function incomingObjectBytes(updates) {
  const newObjects = updates
    .filter((update) => !/^0+$/.test(update.newOid))
    .map((update) => update.newOid);
  if (!newObjects.length) return 0;
  let output;
  try {
    output = git(["rev-list", "--objects", ...newObjects, "--not", "--all"]);
  } catch {
    // A shallow or truncated quarantine is git's problem to reject; do not
    // block a push because the size probe could not read it.
    return 0;
  }
  const oids = output
    .split("\n")
    .map((line) => line.split(" ")[0])
    .filter((oid) => /^[0-9a-f]{40,64}$/.test(oid));
  if (!oids.length) return 0;
  const check = execFileSync(GIT, ["--git-dir", gitDir, "cat-file", "--batch-check"], {
    input: oids.join("\n"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let bytes = 0;
  for (const line of check.split("\n")) {
    const parts = line.trim().split(" ");
    if (parts.length >= 3 && /^\d+$/.test(parts[2])) bytes += Number(parts[2]);
  }
  return bytes;
}

function directoryBytes(path) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += directoryBytes(target);
      else if (entry.isFile()) total += statSync(target).size;
    } catch {
      /* a repository being packed or removed; ignore */
    }
  }
  return total;
}

function mb(bytes) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function main() {
  // `git init` runs this file only through the installed hook, which passes
  // the subject. Anything else (an operator running git by hand) is trusted.
  if (!gitDir || !subject) return;

  const input = readFileSync(0, "utf8");
  const updates = input
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter((parts) => parts.length >= 3)
    .map(([oldOid, newOid, ref]) => ({ oldOid, newOid, ref }));

  const incoming = incomingObjectBytes(updates);
  const repoTotal = existingRepoBytes() + incoming;
  if (repoTotal > REPO_MAX) {
    console.error(
      `Hook: this project is ${mb(repoTotal)}, over the ${mb(REPO_MAX)} limit. ` +
        "Remove build output, dependencies (node_modules, .venv, dist) or large files, commit, and push again.",
    );
    process.exit(1);
  }

  // Repos of one account live under one hashed folder, so the total is the
  // folder size plus what this push adds to the current repository.
  const ownerTotal = directoryBytes(dirname(gitDir)) + incoming;
  if (ownerTotal > USER_MAX) {
    console.error(
      `Hook: this account's projects total ${mb(ownerTotal)}, over the ${mb(USER_MAX)} limit. ` +
        "Delete files or whole projects you no longer need, then push again.",
    );
    process.exit(1);
  }
}

main();
