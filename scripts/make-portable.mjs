#!/usr/bin/env node
/**
 * Package the portable build.
 *
 * Hook ships its coding engine as app resources, so a portable copy is a folder,
 * not a single file: `Hook.exe` plus the runtime it launches. This script zips
 * exactly what the executable looks for, so it works from a USB stick or an
 * unzipped folder without an installer.
 *
 * Run after `tauri build --no-bundle`:
 *   node scripts/make-portable.mjs
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "src-tauri", "target", "release");
const out = join(root, "release");
const stage = join(out, "portable");

const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;

const exe = join(release, "Hook.exe");
if (!existsSync(exe)) {
  throw new Error("src-tauri/target/release/Hook.exe is missing — run `tauri build --no-bundle` first");
}

// Tauri copies resources under `resources/` for a no-bundle build.
function resource(name) {
  const candidates = [join(release, "resources", name), join(release, name)];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`resources/${name} was not copied next to the executable — fetch it, then rebuild`);
  }
  return found;
}
const runtime = resource("pi-runtime");
const git = resource("git");

await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "resources"), { recursive: true });
await cp(exe, join(stage, "Hook.exe"));
await cp(runtime, join(stage, "resources", "pi-runtime"), { recursive: true });
await cp(git, join(stage, "resources", "git"), { recursive: true });

// A note, because a folder with an exe in it deserves one.
await writeFile(
  join(stage, "README.txt"),
  [
    "Hook (portable)",
    "",
    "Run Hook.exe. Nothing is installed and no registry keys are written.",
    "",
    "Keep this folder together: Hook.exe reads the coding engine from",
    "resources\\pi-runtime. Your chats live in %APPDATA%\\app.hook.chat.",
    "",
  ].join("\r\n"),
);

const zip = join(out, `Hook-${version}-portable.zip`);
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
