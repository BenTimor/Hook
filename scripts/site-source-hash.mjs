#!/usr/bin/env node
/**
 * A fingerprint of everything the Hook server container is built from.
 *
 * `scripts/deploy-waitlist.sh` compares it with the one recorded on the server
 * and rebuilds the Docker image only when it changed. Marketing copy, the
 * landing page and the shared packages are built in CI and served by Caddy, so
 * they change the site without touching the image: those deploys ship a tarball
 * instead of running a cold `pnpm install` on the VPS.
 *
 * Include: what the container runs — the server, the content it serves, the
 * manifests and lockfile that resolve its dependencies, the image definition.
 * Exclude: the desktop products, the frontends and the shared packages, which
 * the container never loads.
 *
 *   node scripts/site-source-hash.mjs
 *   node scripts/site-source-hash.mjs --json
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { root } from "./products.mjs";

/**
 * Everything the image copies or the server reads, relative to the repo root.
 * `Dockerfile` and `.dockerignore` are here because they decide what ends up
 * inside it; the workspace manifests are here because `pnpm install` resolves
 * against the lockfile plus every member's package.json, not its source.
 */
export function siteInputs() {
  return [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "release.config.json",
    "server",
    "waitlist/content.json",
    "apps/chat/package.json",
    "apps/workspace/package.json",
    "packages/ui/package.json",
    "packages/chat/package.json",
  ];
}

function walk(target, out) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    out.push(target);
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    walk(join(target, entry.name), out);
  }
}

/**
 * @param {{root?: string}} [options]
 * @returns {string} `s1:<sha256>` over every included path and its bytes.
 */
export function siteSourceHash({ root: dir = root } = {}) {
  const files = [];
  for (const input of siteInputs()) walk(join(dir, input), files);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    const name = relative(dir, file).split(sep).join("/");
    digest.update(name);
    digest.update("\0");
    // Same normalization as the product hash: the gate and the build may run
    // on different platforms, and CRLF is not a release.
    const bytes = readFileSync(file);
    digest.update(
      bytes.includes(0) ? bytes : bytes.toString("utf8").replace(/\r\n/g, "\n"),
    );
    digest.update("\0");
  }
  return `s1:${digest.digest("hex")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hash = siteSourceHash();
  if (process.argv.includes("--json")) console.log(JSON.stringify({ sourceHash: hash }));
  else console.log(hash);
}
