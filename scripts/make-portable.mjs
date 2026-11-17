#!/usr/bin/env node
/**
 * Package a product's portable build.
 *
 * Hook ships its coding engine as app resources, so a portable copy is a
 * folder, not a single file: the executable plus the runtime it launches. This
 * script zips exactly what the executable looks for, so it works from a USB
 * stick or an unzipped folder without an installer.
 *
 * Run after `tauri build --no-bundle`:
 *   node scripts/make-portable.mjs --product chat
 */
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { productFromArgs, root, targetDir } from "./products.mjs";

const run = promisify(execFile);

const product = productFromArgs();
const release = join(targetDir, "release");
const out = join(root, "release");
const stage = join(out, "portable");

const version = JSON.parse(
  await readFile(join(root, product.dir, "package.json"), "utf8"),
).version;

const exe = join(release, `${product.binary}.exe`);
if (!existsSync(exe)) {
  throw new Error(
    `target/release/${product.binary}.exe is missing — run \`tauri build --no-bundle\` first`,
  );
}

// Tauri copies resources under `resources/` for a no-bundle build.
function resource(name) {
  const candidates = [join(release, "resources", name), join(release, name)];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `resources/${name} was not copied next to the executable — fetch it, then rebuild`,
    );
  }
  return found;
}
const runtime = resource("pi-runtime");
const git = resource("git");

await rm(stage, { recursive: true, force: true });
await stage_mkdir();
await cp(exe, join(stage, `${product.binary}.exe`));
await cp(runtime, join(stage, "resources", "pi-runtime"), { recursive: true });
await cp(git, join(stage, "resources", "git"), { recursive: true });

// A note, because a folder with an exe in it deserves one.
await writeFile(
  join(stage, "README.txt"),
  [
    `${product.name} (portable)`,
    "",
    `Run ${product.binary}.exe. Nothing is installed and no registry keys are written.`,
    "",
    "Keep this folder together: the app reads the coding engine from",
    `resources\\pi-runtime. Your data lives in %APPDATA%\\${product.identifier}.`,
    "",
  ].join("\r\n"),
);

const zip = join(out, `${product.binary}-${version}-portable.zip`);
await rm(zip, { force: true });
// Compress-Archive is the one archiver that exists on every Windows box.
await run(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`,
  ],
  { windowsHide: true },
);

const size = (await stat(zip)).size;
console.log(`portable zip: ${zip} (${(size / 1048576).toFixed(1)} MB)`);

async function stage_mkdir() {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(stage, "resources"), { recursive: true });
}
