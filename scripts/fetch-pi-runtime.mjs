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

  // pnpm links the package into the root node_modules. Read that path
  // directly: the package's `exports` map does not expose package.json, and
  // `require.resolve` on a symlinked path does not see the real store's
  // sibling dependencies.
  const local = join(root, "node_modules", ...PACKAGE.split("/"));
  try {
    const parsed = JSON.parse(await readFile(join(local, "package.json"), "utf8"));
    if (parsed.name === PACKAGE) return local;
  } catch {
    /* not installed locally */
  }

  const npmRoot = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
    shell: process.platform === "win32",
  });
  const global = join(npmRoot.stdout.trim(), ...PACKAGE.split("/"));
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

  const nodeExe = join(out, process.platform === "win32" ? "node.exe" : "node");
  await cp(nodeSrc, nodeExe);
  // `dist` is the whole self-contained bundle (21 MB). Almost nothing from
  // node_modules is needed — except the loader used to read extensions, which
  // is required at runtime and cannot be inlined.
  await cp(join(piDir, "dist"), join(out, "pi", "dist"), { recursive: true });
  await cp(join(piDir, "package.json"), join(out, "pi", "package.json"));

  const externals = ["jiti"];
  for (const name of externals) {
    // npm nests dependencies under pi/node_modules; pnpm puts them next to
    // the package inside .pnpm/.../node_modules. Try both, then the hidden
    // pnpm hoist directory.
    const candidates = [
      join(piDir, "node_modules", name),
      join(dirname(piDir), name),
      join(root, "node_modules", ".pnpm", "node_modules", name),
      join(root, "node_modules", name),
    ];
    let from = null;
    for (const candidate of candidates) {
      try {
        await stat(join(candidate, "package.json"));
        from = candidate;
        break;
      } catch {
        /* try the next layout */
      }
    }
    if (!from) {
      throw new Error(`pi is missing ${name}; Hook's guard would not load`);
    }
    // dereference: pnpm's store entries are symlinks, and a copied relative
    // symlink would point outside the shipped runtime.
    await cp(from, join(out, "pi", "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  }

  await writeFile(
    join(out, "VERSION"),
    `${PACKAGE} ${version}\nnode ${process.version}\nfetched ${new Date().toISOString()}\n`,
  );

  // Prove the shipped layout can actually load an extension before anyone
  // packages it: `jiti` must resolve from the bundle.
  try {
    await run(
      nodeExe,
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
