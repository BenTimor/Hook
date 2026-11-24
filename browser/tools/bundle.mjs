#!/usr/bin/env node
/**
 * Build the dock bundle with the repository's own Vite.
 *
 *   node browser/tools/bundle.mjs --out <dir>
 *
 * `--out` is the directory the bundle lands in; the file name is fixed by the
 * Vite config (`panel.mjs`), because a WebUI resource is addressed by its path.
 * `browser/tools/build.mjs` points it at the overlay's resources directory before
 * ninja runs — the bundle is generated now, not committed.
 *
 * Vite is a devDependency of the repository, which is why this runs from the
 * repository root and not from the Chromium tree: GN cannot list `node_modules`
 * as inputs, so a wrapper step is where this lives (see `docs/browser-poc-plan.md`,
 * "The dock bundle as a build step").
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

const { values } = parseArgs({
  options: { out: { type: "string" } },
  allowPositionals: true,
});

if (!values.out) {
  console.error("bundle.mjs: --out <dir> is required");
  process.exit(1);
}

process.env.HOOK_BUNDLE_OUT = resolve(values.out);

await build({
  configFile: resolve(repo, "browser/ui/vite.config.ts"),
  logLevel: "warn",
});
