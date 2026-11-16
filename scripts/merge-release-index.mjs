#!/usr/bin/env node
/**
 * Merge a freshly built manifest into the published release index.
 *
 *   node scripts/merge-release-index.mjs \
 *     --manifest release/latest.json \
 *     --out release/releases.json \
 *     --server https://hookcode.io \
 *     --keep 5
 *
 * The index is written last and swapped atomically on the server, so the
 * version users are downloading right now stays available until the new one
 * is complete. Older versions stay in the index (and on disk) for rollbacks.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareVersions } from "../server/releases.mjs";

/**
 * Pure merge: the new build becomes `latest`, older entries are kept (newest
 * first) up to `keep`, and the result matches what `server/releases.mjs` reads.
 */
export function mergeReleaseIndex(published, manifest, keep = 5) {
  const releases = {};
  for (const release of published) {
    if (release?.version) releases[release.version] = release;
  }
  releases[manifest.version] = {
    file: manifest.file,
    size: manifest.size,
    sha256: manifest.sha256,
    builtAt: manifest.builtAt,
    commit: manifest.commit ?? null,
    notes: manifest.notes ?? null,
    sourceHash: manifest.sourceHash ?? null,
  };

  const versions = Object.keys(releases).sort((a, b) => compareVersions(b, a));
  for (const version of versions.slice(Math.max(1, keep))) delete releases[version];

  return {
    latest: manifest.version,
    updatedAt: manifest.builtAt,
    releases,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifest;
  const outPath = args.out;
  const server = (args.server || "https://hookcode.io").replace(/\/+$/, "");
  const keep = Number(args.keep || 5);
  if (!manifestPath || !outPath) {
    console.error(
      "usage: node scripts/merge-release-index.mjs --manifest <file> --out <file> [--server url] [--keep 5]",
    );
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.version || !manifest.file || !manifest.sha256) {
    throw new Error(`${manifestPath} is missing version, file or sha256`);
  }

  let published = [];
  try {
    const response = await fetch(`${server}/api/releases`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      // Older deployments predate /api/releases; the first versioned publish
      // still has to work before the website catches up.
      console.warn(
        `warning: ${server}/api/releases does not exist yet; starting a fresh index`,
      );
    } else {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      published = (await response.json()).releases ?? [];
    }
  } catch (error) {
    if (!args["allow-empty"]) {
      throw new Error(
        `could not read ${server}/api/releases (${error.message}); refusing to replace the version history`,
      );
    }
    console.warn(`warning: starting a fresh release index (${error.message})`);
  }

  const index = mergeReleaseIndex(published, manifest, keep);
  await writeFile(outPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(
    `release index: ${Object.keys(index.releases).length} version(s), latest ${index.latest}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
