#!/usr/bin/env node
/**
 * Package Hook as an unsigned MSIX for Microsoft Store submission.
 *
 *   pnpm app:msix                     # build the app, then package
 *   node scripts/build-msix.mjs       # package an existing build
 *
 * Microsoft re-signs Store submissions, so the package is written unsigned
 * (`makeappx /nv`). Fill msix/identity.json with the values from Partner Center
 * first; until then this exits 0 with instructions, so a direct release is
 * never blocked by an unconfigured Store identity.
 *
 * The package layout mirrors the portable build: Hook.exe next to
 * resources/pi-runtime, which runtime.rs already searches.
 *
 * Local sideload testing only:
 *   node scripts/build-msix.mjs --sign dev.pfx --password <password>
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Partner Center → product → Package identity. */
const identity = JSON.parse(
  await readFile(join(root, "msix/identity.json"), "utf8"),
);
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const archIndex = process.argv.indexOf("--arch");
const arch = archIndex >= 0 ? process.argv[archIndex + 1] : "x64";
if (!["x64", "arm64"].includes(arch)) {
  throw new Error(`unsupported architecture: ${arch}`);
}

// MSIX versions have four numeric parts; semver prerelease suffixes do not
// belong in a Store package version.
const version = `${pkg.version.split("-")[0]}.0`;

if (!identity.identityName?.trim() || !identity.publisher?.trim()) {
  console.log("MSIX is not configured yet — nothing to package.");
  console.log("  1. Reserve Hook in Partner Center (MSIX or PWA app).");
  console.log("  2. Copy Identity Name and Publisher into msix/identity.json.");
  console.log("  3. Put the Store product id in harness.config.ci.toml [update] store_id.");
  console.log("  4. Run `pnpm app:msix` again (or use the release workflow artifact).");
  process.exit(0);
}

const exe = join(root, "src-tauri/target/release/Hook.exe");
const runtime = join(root, "src-tauri/resources/pi-runtime");
const git = join(root, "src-tauri/resources/git");
if (!existsSync(exe)) {
  throw new Error("Hook.exe is missing; run `pnpm app:build` (or `pnpm app`) first.");
}
if (!existsSync(join(runtime, "node.exe"))) {
  throw new Error("the coding engine is missing; run `pnpm engine` first.");
}
if (!existsSync(join(git, "cmd", "git.exe"))) {
  throw new Error("git is missing; run `pnpm git` first.");
}

const stage = join(root, ".tmp/msix", pkg.version);
await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "Assets"), { recursive: true });

await cp(exe, join(stage, "Hook.exe"));
// 104 MB of Node + pi. runtime.rs finds it at <package>/resources/pi-runtime
// (via resource_dir, the exe directory, or their `resources` children).
await cp(runtime, join(stage, "resources", "pi-runtime"), { recursive: true });
// MinGit: the coding agents pull and push their project with it.
await cp(git, join(stage, "resources", "git"), { recursive: true });

const icons = [
  "StoreLogo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square150x150Logo.png",
];
for (const icon of icons) {
  await cp(join(root, "src-tauri/icons", icon), join(stage, "Assets", icon));
}

const manifest = await readFile(join(root, "msix/AppxManifest.xml"), "utf8");
const filled = manifest
  .replaceAll("{{IDENTITY_NAME}}", identity.identityName.trim())
  .replaceAll("{{PUBLISHER}}", identity.publisher.trim())
  .replaceAll("{{PUBLISHER_DISPLAY_NAME}}", (identity.publisherDisplayName || "Hook").trim())
  .replaceAll("{{VERSION}}", version)
  .replaceAll("{{ARCH}}", arch);
await writeFile(join(stage, "AppxManifest.xml"), filled);

const release = join(root, "release");
await mkdir(release, { recursive: true });
const output = join(release, `Hook-${pkg.version}-${arch}.msix`);
await rm(output, { force: true });
// makeappx prints one line per payload file; the default execFile buffer is
// only 1 MB, which a 130 MB package easily exceeds.
await run(findTool("makeappx", arch), ["pack", "/d", stage, "/p", output], {
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
});

// Store packages are uploaded unsigned. Signing is only for sideload testing.
const signIndex = process.argv.indexOf("--sign");
if (signIndex >= 0) {
  const cert = resolve(process.argv[signIndex + 1] ?? "");
  const passwordIndex = process.argv.indexOf("--password");
  const password = passwordIndex >= 0 ? process.argv[passwordIndex + 1] : "";
  if (!existsSync(cert)) throw new Error(`certificate not found: ${cert}`);
  const args = ["sign", "/fd", "SHA256", "/f", cert, "/p", password, output];
  await run(findTool("signtool", arch), args, { windowsHide: true });
  console.log(`signed for sideload testing: ${output}`);
}

const size = (await stat(output)).size;
console.log(`MSIX (unsigned): ${output} (${(size / 1048576).toFixed(1)} MB)`);
console.log("Upload it to Partner Center → Submission → Packages.");

/** Find a Windows SDK tool (makeappx/signtool) for the requested architecture. */
function findTool(name, architecture) {
  const exeName = `${name}.exe`;
  const candidates = [];

  const override = process.env[name === "makeappx" ? "MAKEAPPX" : "SIGNTOOL"];
  if (override) candidates.push(override);

  for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
    if (!base) continue;
    const bin = join(base, "Windows Kits", "10", "bin");
    if (!existsSync(bin)) continue;
    const versions = readdirSync(bin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) {
      candidates.push(join(bin, version, architecture, exeName));
    }
  }

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `${exeName} was not found. Install the Windows 10/11 SDK (Windows Kits 10).`,
    );
  }
  return found;
}
