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
 *    node scripts/fetch-pi-runtime.mjs [app-dir] [--pi <path-to-pi-package>]
 *
 * Layout it produces (Windows and macOS; the Node binary is named `node.exe`
 * on Windows and `node` elsewhere):
 *
 *    src-tauri/resources/pi-runtime/node.exe      (or `node` on macOS)
 *    src-tauri/resources/pi-runtime/pi/dist/bundle/cli.js
 *    src-tauri/resources/pi-runtime/pi/package.json
 *    src-tauri/resources/pi-runtime/pi/node_modules/@silvia-odwyer/photon-node/
 *
 * `pnpm app:build` runs this automatically. The copy is the Node running the
 * script, so a local Apple-silicon build ships an arm64 runtime; a universal
 * app needs a universal (or per-architecture) Node, which is part of the
 * signed macOS release work rather than this dev path.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The app directory to populate: `node scripts/fetch-pi-runtime.mjs apps/chat`.
const app = resolve(process.cwd(), process.argv[2] ?? "apps/chat");
const out = join(app, "src-tauri", "resources", "pi-runtime");

const PACKAGE = "@earendil-works/pi-coding-agent";
/** The engine's image decoder: `read` cannot hand a coding agent a picture without it. */
const PHOTON = "@silvia-odwyer/photon-node";

const nodeExe = join(out, process.platform === "win32" ? "node.exe" : "node");

/** The Node binary a build ships: the one running this script. */
const nodeExecutable = () => process.execPath;

/**
 * The VERSION file records the pi package and the Node build. When both match
 * what is on disk, the 130 MB copy is skipped: `pnpm app:build` runs this on
 * every build, and the shipped runtime only changes after a bump.
 */
function installed(version) {
  let recorded;
  try {
    recorded = readFileSync(join(out, "VERSION"), "utf8")
      .split("\n")
      .slice(0, 2)
      .join("\n");
  } catch {
    return false;
  }
  if (recorded !== `${PACKAGE} ${version}\nnode ${process.version}`) return false;
  return (
    existsSync(nodeExe) &&
    existsSync(join(out, "pi", "dist", "bundle", "cli.js")) &&
    existsSync(join(out, "pi", "node_modules", "jiti", "package.json")) &&
    // Without photon the engine cannot resize a picture, so its `read` tool
    // answers every image with "[Image omitted]". A runtime built before it was
    // shipped has to be rebuilt, or coding agents stay blind to images.
    existsSync(join(out, "pi", "node_modules", PHOTON, "package.json")) &&
    existsSync(join(out, "pi", "node_modules", PHOTON, "photon_rs_bg.wasm")) &&
    // The licenses are part of the shipped bundle, not a nicety. An existing
    // runtime built before they were written must be rebuilt, or an installer
    // redistributes MIT and GPL software without its notices.
    existsSync(join(out, "THIRD-PARTY-LICENSES.txt")) &&
    existsSync(join(out, "node-LICENSE.txt")) &&
    existsSync(join(out, "pi", "node_modules", "jiti", "LICENSE"))
  );
}

const MIT_TEXT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * Write the notices that have to travel with the bundled binaries.
 *
 * pi's npm package declares `"license": "MIT"` in package.json but ships no
 * LICENSE file, so its notice is reconstructed from that metadata (name,
 * version, `author`, `repository`). Verify against the upstream repository when
 * the version moves — it is the only source of truth that was not packaged.
 *
 * Node's LICENSE sits next to the `node` executable in a normal installation,
 * so it is copied rather than reconstructed. jiti's LICENSE is already inside
 * the copied package; this file only points at it.
 */
async function writeLicenses(piMeta) {
  const nodeLicense = join(dirname(nodeExecutable()), "LICENSE");
  try {
    await cp(nodeLicense, join(out, "node-LICENSE.txt"));
  } catch {
    throw new Error(
      `could not find Node's LICENSE next to ${nodeExecutable()} — a redistributed ` +
        "runtime must carry it. Install Node from nodejs.org, or place LICENSE " +
        "beside the executable.",
    );
  }

  const piAttribution = [
    `${PACKAGE} ${piMeta.version}`,
    piMeta.author ? `Copyright (c) ${piMeta.author}` : "",
    `Licensed under the MIT License, as declared in the package's package.json.`,
    piMeta.repository?.url
      ? `Source: ${piMeta.repository.url.replace(/^git\+/, "")}`
      : "",
    "This npm package ships no LICENSE file; this notice is reconstructed from",
    "its package metadata.",
    "",
    MIT_TEXT,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const text = [
    "Third-party licenses for the Hook coding runtime",
    "=================================================",
    "",
    "This directory is redistributed inside a Hook installer. Everything in it",
    "is listed below, with the license it is offered under.",
    "",
    "Hook itself is AGPL-3.0-only; see LICENSE and NOTICE in the repository.",
    "",
    "--- 1/3 " + "-".repeat(60),
    piAttribution,
    "",
    "--- 2/3 " + "-".repeat(60),
    `Node.js ${process.version}`,
    "Licensed under the MIT License.",
    "Full text: node-LICENSE.txt, in this directory.",
    "https://nodejs.org/",
    "",
    "--- 3/4 " + "-".repeat(60),
    "jiti",
    "Licensed under the MIT License.",
    "Full text: pi/node_modules/jiti/LICENSE, in this directory.",
    "https://github.com/unjs/jiti",
    "",
    "--- 4/4 " + "-".repeat(60),
    "@silvia-odwyer/photon-node (Photon, the engine's image resizer)",
    "Licensed under the Apache License 2.0.",
    "Full text: pi/node_modules/@silvia-odwyer/photon-node/LICENSE.md, in this directory.",
    "https://github.com/silvia-odwyer/photon",
    "",
  ].join("\n");

  await writeFile(join(out, "THIRD-PARTY-LICENSES.txt"), text);
}

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
  const piMeta = JSON.parse(await readFile(join(piDir, "package.json"), "utf8"));
  const version = piMeta.version;
  const bundle = join(piDir, "dist", "bundle", "cli.js");
  await stat(bundle);

  if (installed(version)) {
    console.log(`pi-runtime already at pi ${version} on node ${process.version}`);
    console.log(`  ${out}`);
    return;
  }

  const nodeSrc = nodeExecutable();
  const nodeStat = await stat(nodeSrc);
  if (nodeStat.size < 1_000_000) {
    throw new Error(`${nodeSrc} does not look like a Node runtime`);
  }

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "pi"), { recursive: true });

  await cp(nodeSrc, nodeExe);
  // `dist` is the whole self-contained bundle (21 MB). Almost nothing from
  // node_modules is needed — except the loader used to read extensions, which
  // is required at runtime and cannot be inlined.
  await cp(join(piDir, "dist"), join(out, "pi", "dist"), { recursive: true });
  await cp(join(piDir, "package.json"), join(out, "pi", "package.json"));

  // `jiti` loads the guard, and photon resizes the pictures a coding agent
  // reads (`read shot.png`). Both are bare imports in the bundle, so both have
  // to be resolvable from the shipped layout or the feature dies quietly.
  const externals = ["jiti", PHOTON];
  for (const name of externals) {
    // npm nests dependencies under pi/node_modules; pnpm puts them next to
    // the package inside .pnpm/.../node_modules. Try both, then the hidden
    // pnpm hoist directory.
    const candidates = [
      join(piDir, "node_modules", name),
      // pnpm's isolated layout: the package's own dependencies are siblings in
      // `<store>/<pkg>@<version>/node_modules/`.
      join(dirname(dirname(piDir)), name),
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
      throw new Error(
        name === "jiti"
          ? `pi is missing ${name}; Hook's guard would not load`
          : `pi is missing ${name}; a coding agent could not look at a picture`,
      );
    }
    // dereference: pnpm's store entries are symlinks, and a copied relative
    // symlink would point outside the shipped runtime.
    await cp(from, join(out, "pi", "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  }

  await writeLicenses(piMeta);

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

  // And that photon really loads, wasm included: a resolvable package whose
  // .wasm is missing is exactly the silent failure that made every screenshot
  // come back as "[Image omitted]".
  const bundleDir = join(out, "pi", "dist", "bundle");
  try {
    await run(
      nodeExe,
      [
        "-e",
        `const { createRequire } = require("module");` +
          `const photon = createRequire(${JSON.stringify(join(bundleDir, "probe.js"))})(${JSON.stringify(
            PHOTON,
          )});` +
          `if (typeof photon.PhotonImage !== "function") { throw new Error("no PhotonImage export"); }`,
      ],
      { cwd: out },
    );
  } catch (error) {
    throw new Error(`the bundled runtime cannot load photon: ${error.message}`);
  }

  console.log(`pi-runtime ready: pi ${version} on node ${process.version}`);
  console.log(`  ${out}`);
}

main().catch((error) => {
  console.error(`fetch-pi-runtime failed: ${error.message}`);
  process.exit(1);
});
