#!/usr/bin/env node
/**
 * Decide whether a push actually needs a new Windows build.
 *
 * A rebuild is expensive and every new build asks users to update, so the
 * answer is "only when the application source changed":
 *
 *   - same source as the published latest version  -> skip
 *   - changed source, same version                 -> fail: bump the version
 *   - changed source, higher version               -> build and publish
 *   - published index unreachable                  -> build (never silently skip)
 *
 *   node scripts/release-gate.mjs [--force] [--server https://hookcode.io]
 *
 * Writes `publish`, `version` and `source_hash` to $GITHUB_OUTPUT when set.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appSourceHash } from "./app-source-hash.mjs";
import { compareVersions, parseVersion } from "../server/releases.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The app reports Cargo's version and the installer is named after Tauri's. */
export function readRepoVersion() {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const tauri = JSON.parse(
    readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
  ).version;
  const cargo = /\[package\][\s\S]*?\r?\nversion\s*=\s*"([^"]+)"/.exec(
    readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8"),
  )?.[1];
  const versions = { "package.json": pkg, "tauri.conf.json": tauri, "Cargo.toml": cargo };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    throw new Error(
      `version mismatch: ${Object.entries(versions)
        .map(([file, value]) => `${file}=${value}`)
        .join(", ")} — run \`pnpm version:bump\` instead of editing one file`,
    );
  }
  if (!parseVersion(pkg)) throw new Error(`not a semver version: ${pkg}`);
  return pkg;
}

/**
 * Pure decision, exported for tests.
 * @returns {{publish: boolean, reason: string, error?: string}}
 */
export function decide({ version, sourceHash, published }) {
  const releases = Array.isArray(published?.releases) ? published.releases : [];
  const latestEntry =
    releases.find((release) => release.version === published?.latest) ?? releases[0];

  if (!latestEntry?.version) {
    return { publish: true, reason: "no published release yet" };
  }

  if (latestEntry.sourceHash && latestEntry.sourceHash === sourceHash) {
    return {
      publish: false,
      reason: `application source is identical to the published Hook ${latestEntry.version}`,
    };
  }

  if (version === latestEntry.version) {
    return {
      publish: false,
      error:
        `Hook ${version} is already published but the application source changed. ` +
        `Run \`pnpm version:bump patch\` (or minor/major), commit and push again.`,
      reason: "source changed without a version bump",
    };
  }

  if (compareVersions(version, latestEntry.version) < 0) {
    return {
      publish: false,
      error: `Hook ${version} is older than the published Hook ${latestEntry.version}; refusing to downgrade.`,
      reason: "downgrade",
    };
  }

  return {
    publish: true,
    reason: `new version: ${latestEntry.version} -> ${version}`,
  };
}

async function fetchPublished(server) {
  const url = `${server.replace(/\/+$/, "")}/api/releases`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function writeOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const serverArg = args.indexOf("--server");
  const server =
    (serverArg >= 0 ? args[serverArg + 1] : null) ||
    process.env.HOOK_RELEASES_URL ||
    "https://hookcode.io";

  const version = readRepoVersion();
  const sourceHash = appSourceHash();
  console.log(`Hook ${version}  source ${sourceHash.slice(0, 19)}…`);

  let published = null;
  let lookupError = null;
  try {
    published = await fetchPublished(server);
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  const result = force
    ? { publish: true, reason: "--force" }
    : lookupError
      ? {
          publish: true,
          reason: `could not read the published releases (${lookupError}); building to be safe`,
        }
      : decide({ version, sourceHash, published });

  if (lookupError) console.warn(`warning: ${lookupError}`);
  if (published?.latest) console.log(`published: Hook ${published.latest}`);
  if (result.error) {
    console.error(`::error::${result.error}`);
  } else {
    console.log(`${result.publish ? "build" : "skip"}: ${result.reason}`);
    if (result.publish) console.log(`::notice::Publishing Hook ${version}`);
    else console.log(`::notice::No application change; skipping the Windows build`);
  }

  writeOutput({ publish: String(result.publish && !result.error), version, source_hash: sourceHash });
  if (result.error) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
