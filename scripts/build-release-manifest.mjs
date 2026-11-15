#!/usr/bin/env node
/**
 * Build the small manifest the download endpoint serves next to the installer.
 *
 *   node scripts/build-release-manifest.mjs <installer> <manifest> [version]
 *
 * The release workflow runs this on Windows, uploads both files to
 * /opt/hook-web/data/releases, and the website then reports the new version and
 * checksum automatically. The download route streams the installer only to
 * signed-in, approved accounts.
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [, , installerArg, manifestArg, versionArg] = process.argv;
if (!installerArg || !manifestArg) {
  console.error(
    "usage: node scripts/build-release-manifest.mjs <installer> <manifest> [version]",
  );
  process.exit(1);
}

const installer = resolve(installerArg);
const manifest = resolve(manifestArg);
const bytes = await readFile(installer);
const info = await stat(installer);
const pkg = JSON.parse(
  await readFile(resolve("package.json"), "utf8"),
);
let tauriVersion = null;
try {
  const tauri = JSON.parse(
    await readFile(resolve("src-tauri/tauri.conf.json"), "utf8"),
  );
  tauriVersion = tauri.version ?? null;
} catch {
  // A standalone checkout may not have the Tauri config; fall back to package.json.
}
const commit = (process.env.GITHUB_SHA || process.env.HOOK_COMMIT || "").slice(0, 12);

const payload = {
  version: versionArg || process.env.HOOK_VERSION || tauriVersion || pkg.version,
  commit: commit || null,
  builtAt: new Date().toISOString(),
  file: "Hook-setup.exe",
  size: info.size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};

await writeFile(manifest, `${JSON.stringify(payload, null, 2)}\n`);
console.log(
  `wrote ${manifest}: Hook ${payload.version} (${(payload.size / 1024 / 1024).toFixed(1)} MB) ${payload.sha256.slice(0, 12)}…`,
);
