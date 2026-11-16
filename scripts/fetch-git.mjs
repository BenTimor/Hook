#!/usr/bin/env node
/**
 * Populate `src-tauri/resources/git/` with the git Hook ships.
 *
 * Coding agents pull and push their project from the user's Hook account, and
 * the user is not expected to install git. MinGit is the official minimal
 * git-for-Windows distribution: `cmd/git.exe`, the core commands and the HTTPS
 * transport, without bash, Perl or the Unix tools Hook does not need.
 *
 *   node scripts/fetch-git.mjs
 *
 * The archive is cached under `.git-runtime-cache/` and checked by SHA-256
 * before anything is extracted. `pnpm app:build` runs this automatically.
 *
 * Layout it produces:
 *
 *   src-tauri/resources/git/cmd/git.exe
 *   src-tauri/resources/git/ucrt64/bin/git.exe
 *   src-tauri/resources/git/LICENSE.txt
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "resources", "git");
const cache = join(root, ".git-runtime-cache");

const VERSION = "2.56.1";
const ARCHIVE = `MinGit-${VERSION}-64-bit.zip`;
const URL =
  `https://github.com/git-for-windows/git/releases/download/` +
  `v${VERSION}.windows.1/${ARCHIVE}`;
const SHA256 =
  "4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd";

function digest(path) {
  const hash = createHash("sha256");
  const bytes = readFileSync(path);
  hash.update(bytes);
  return hash.digest("hex");
}

async function download(target) {
  if (existsSync(target) && digest(target) === SHA256) return;
  mkdirSync(dirname(target), { recursive: true });
  console.log(`hook: downloading ${ARCHIVE}…`);
  const response = await fetch(URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${URL} (${response.status})`);
  }
  const temp = `${target}.part`;
  await new Promise((done, fail) => {
    const file = createWriteStream(temp);
    const reader = response.body.getReader();
    const pump = async () => {
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          if (!file.write(Buffer.from(value)))
            await new Promise((ok) => file.once("drain", ok));
        }
        file.end(done);
      } catch (error) {
        file.destroy();
        fail(error);
      }
    };
    pump();
  });
  const actual = digest(temp);
  if (actual !== SHA256) {
    rmSync(temp, { force: true });
    throw new Error(
      `${ARCHIVE} did not match its pinned SHA-256.\n  expected ${SHA256}\n  got      ${actual}`,
    );
  }
  renameSync(temp, target);
}

async function extract(archive, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  if (process.platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`,
    ]);
    return;
  }
  await run("unzip", ["-q", archive, "-d", destination]);
}

async function main() {
  const archive = join(cache, ARCHIVE);
  await download(archive);

  const staging = join(cache, `extract-${VERSION}`);
  await extract(archive, staging);
  const launcher = join(staging, "cmd", "git.exe");
  const real = join(staging, "ucrt64", "bin", "git.exe");
  if (!existsSync(launcher)) {
    throw new Error(`${ARCHIVE} did not contain cmd/git.exe`);
  }
  if (!existsSync(real) || statSync(real).size < 1_000_000) {
    throw new Error(`${ARCHIVE} did not contain the git binary`);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  cpSync(staging, out, { recursive: true });
  writeFileSync(join(out, "VERSION"), `${VERSION}\n`);
  rmSync(staging, { recursive: true, force: true });
  console.log(`hook: git ${VERSION} → ${out}`);
}

main().catch((error) => {
  console.error(`hook: ${error.message}`);
  process.exit(1);
});
