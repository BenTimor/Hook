#!/usr/bin/env node
/**
 * A stable fingerprint of everything that ends up inside Hook.exe or the
 * installer around it. The release workflow compares it with the version it
 * already published, so a push that changes only docs, the website, or a
 * server route does not trigger a twenty-minute Windows rebuild.
 *
 * Include: application source, compiled config, dependencies, installer inputs.
 * Exclude: tests, waitlist/landing page, server, docs, build scripts that only
 * describe an artifact instead of changing it.
 *
 *   node scripts/app-source-hash.mjs        # print the hash
 *   node scripts/app-source-hash.mjs --json
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Paths that change what the desktop app is or what ships with it. */
export const APP_INPUTS = [
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
  "harness.config.ci.toml",
  "msix/AppxManifest.xml",
  "msix/identity.json",
  "scripts/build-msix.mjs",
  "public/favicon.svg",
  "src",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/build.rs",
  "src-tauri/tauri.conf.json",
  "src-tauri/capabilities",
  "src-tauri/icons",
  "src-tauri/src",
  "src-tauri/resources/hook-guard.mjs",
  "scripts/fetch-pi-runtime.mjs",
];

function walk(root, target, out) {
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
    walk(root, join(target, entry.name), out);
  }
}

/** @returns {string} `v2:<sha256>` over every included path and its bytes. */
export function appSourceHash(root = ROOT) {
  const files = [];
  for (const input of APP_INPUTS) walk(root, join(root, input), files);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    const name = relative(root, file).split(sep).join("/");
    digest.update(name);
    digest.update("\0");
    // Normalize line endings so the Linux gate and a Windows build agree,
    // while leaving binaries (icons) byte-for-byte.
    const bytes = readFileSync(file);
    digest.update(
      bytes.includes(0) ? bytes : bytes.toString("utf8").replace(/\r\n/g, "\n"),
    );
    digest.update("\0");
  }
  return `v2:${digest.digest("hex")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hash = appSourceHash();
  if (process.argv.includes("--json")) console.log(JSON.stringify({ sourceHash: hash }));
  else console.log(hash);
}
