#!/usr/bin/env node
/**
 * Populate `src-tauri/resources/pi-runtime/` with the coding engine Hook ships.
 *
 * Hook runs its coding agents on a private copy of the pi coding agent: a Node
 * runtime plus pi's self-contained JS bundle. The user never installs pi, never
 * sees it, and cannot point Hook at a different one.
 *
 * The binaries are ~110 MB, so they are not in git. Run this once after
 * cloning (or when bumping pi):
 *
 *    node scripts/fetch-pi-runtime.mjs [--pi <path-to-pi-package>]
 *
 * Layout it produces:
 *
 *    src-tauri/resources/pi-runtime/node.exe
 *    src-tauri/resources/pi-runtime/pi/dist/bundle/cli.js
 *    src-tauri/resources/pi-runtime/pi/package.json
 *
 * `pnpm app:build` runs this automatically.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "resources", "pi-runtime");

const PACKAGE = "@earendil-works/pi-coding-agent";

/** Find the installed pi package: CLI flag, local resolution, then global npm. */
async function locatePi(flag) {
  if (flag) return resolve(flag);

  const require = createRequire(join(root, "package.json"));
  try {
    let dir = dirname(require.resolve(`${PACKAGE}/package.json`));
    // Walk up until the directory that actually owns the package.json.
    while (dir !== dirname(dir) && !dirname(dir).endsWith(PACKAGE)) {
      const candidate = join(dir, "package.json");
      try {
        const parsed = JSON.parse(await readFile(candidate, "utf8"));
        if (parsed.name === PACKAGE) return dir;
      } catch {
        /* keep walking */
      }
      dir = dirname(dir);
    }
    return dir;
  } catch {
    /* not resolvable from here */
  }

  const npmRoot = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
    shell: process.platform === "win32",
  });
  const global = join(npmRoot.stdout.trim(), PACKAGE);
  await stat(global);
  return global;
}

async function main() {
  const flagIndex = process.argv.indexOf("--pi");
  const explicit = flagIndex > 0 ? process.argv[flagIndex + 1] : undefined;

  const piDir = await locatePi(explicit);
  const version = JSON.parse(await readFile(join(piDir, "package.json"), "utf8")).version;
  const bundle = join(piDir, "dist", "bundle", "cli.js");
  await stat(bundle);

  const nodeSrc = process.execPath;
  const nodeStat = await stat(nodeSrc);
  if (nodeStat.size < 1_000_000) {
    throw new Error(`${nodeSrc} does not look like a Node runtime`);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "pi"), { recursive: true });

  await cp(nodeSrc, join(out, process.platform === "win32" ? "node.exe" : "node"));
  // `dist` is the whole self-contained bundle (21 MB). Almost nothing from
  // node_modules is needed — except the loader used to read extensions, which
  // is required at runtime and cannot be inlined.
  await cp(join(piDir, "dist"), join(out, "pi", "dist"), { recursive: true });
  await cp(join(piDir, "package.json"), join(out, "pi", "package.json"));

  const externals = ["jiti"];
  for (const name of externals) {
    const from = join(piDir, "node_modules", name);
    await stat(from).catch(() => {
      throw new Error(`pi is missing ${name} in node_modules; Hook's guard would not load`);
    });
    await cp(from, join(out, "pi", "node_modules", name), { recursive: true });
  }

  await writeFile(
    join(out, "VERSION"),
    `${PACKAGE} ${version}\nnode ${process.version}\nfetched ${new Date().toISOString()}\n`,
  );

  // Prove the shipped layout can actually load an extension before anyone
  // packages it: `jiti` must resolve from the bundle.
  try {
    await run(
      join(out, "node.exe"),
      [
        "-e",
        `require.resolve("jiti", { paths: [${JSON.stringify(join(out, "pi", "dist", "bundle"))}] })`,
      ],
      { cwd: out },
    );
  } catch (error) {
    throw new Error(`the bundled runtime cannot resolve jiti: ${error.message}`);
  }

  console.log(`pi-runtime ready: pi ${version} on node ${process.version}`);
  console.log(`  ${out}`);
}

main().catch((error) => {
  console.error(`fetch-pi-runtime failed: ${error.message}`);
  process.exit(1);
});
