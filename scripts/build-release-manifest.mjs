#!/usr/bin/env node
/**
 * Build the manifest the download endpoints and the updater read next to an
 * installer.
 *
 *   node scripts/build-release-manifest.mjs <installer> <manifest> [version] [--product <id>]
 *
 * The release script runs this after `tauri build`, uploads the installer under
 * its versioned name, and merges this manifest into the public release index.
 * `sourceHash` is what lets the next release skip a rebuild when nothing that
 * goes into the app changed.
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { appSourceHash } from "./app-source-hash.mjs";
import { productFromArgs } from "./products.mjs";
import { readRepoVersion } from "./release-gate.mjs";

// `--product <id>` is a flag, not a third positional: strip it (and its value)
// before reading the positional arguments, or it is mistaken for the version.
const argv = process.argv.slice(2);
const positionals = argv.filter(
  (arg, index) => arg !== "--product" && argv[index - 1] !== "--product",
);
const [installerArg, manifestArg, versionArg] = positionals;
const product = productFromArgs();
if (!installerArg || !manifestArg) {
  console.error(
    "usage: node scripts/build-release-manifest.mjs <installer> <manifest> [version] [--product <id>]",
  );
  process.exit(1);
}

const installer = resolve(installerArg);
const manifest = resolve(manifestArg);
const bytes = await readFile(installer);
const info = await stat(installer);

// A drift here ships an installer that reports a different version than the
// one users were told about, and every later update check lies.
const repoVersion = readRepoVersion(product);
const version = versionArg || process.env.HOOK_VERSION || repoVersion;
if (version !== repoVersion) {
  throw new Error(
    `requested version ${version} does not match the checked-out version ${repoVersion}`,
  );
}

const commit = (process.env.GITHUB_SHA || process.env.HOOK_COMMIT || "").slice(0, 12);
const notes =
  (process.env.HOOK_RELEASE_NOTES || "").trim().split("\n")[0].slice(0, 200) || null;

const payload = {
  version,
  commit: commit || null,
  builtAt: new Date().toISOString(),
  // The file name is what the download route serves and what the merge script
  // keeps for old versions; every product has its own prefix.
  file: `${
    product.id === "chat" ? "Hook" : product.binary.replaceAll(" ", "-")
  }-${version}-setup.exe`,
  // The chat app keeps the historical route it already knows; a new product
  // names itself explicitly so one download endpoint serves both.
  url:
    product.id === "chat"
      ? `/api/download/windows?version=${encodeURIComponent(version)}`
      : `/api/download/windows?product=${product.id}&version=${encodeURIComponent(version)}`,
  size: info.size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  // The gate runs on Linux and the build on Windows; use its hash so checkout
  // line endings can never make the same commit look like two releases.
  sourceHash: process.env.HOOK_SOURCE_HASH || appSourceHash({ product }),
  notes,
};

await writeFile(manifest, `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `wrote ${manifest}: ${product.name} ${payload.version} (${(payload.size / 1024 / 1024).toFixed(1)} MB) ${payload.sha256.slice(0, 12)}…`,
);
