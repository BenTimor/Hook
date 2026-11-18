#!/usr/bin/env node
/**
 * A stable fingerprint of everything that ends up inside a product executable
 * or the installer around it. The release workflow compares it with the
 * version it already published, so a push that changes only docs, the
 * website, another product, or a server route does not trigger a Windows
 * rebuild.
 *
 * Include: application source, the shared packages and shared crate it links,
 * its compiled config, dependencies, installer inputs.
 * Exclude: tests, the landing page, the server, docs, build scripts that only
 * describe an artifact instead of changing it — including `msix/` and
 * `build-msix.mjs`, which package the exe for the Store without touching it.
 *
 *   node scripts/app-source-hash.mjs                  # chat app
 *   node scripts/app-source-hash.mjs --product workspace
 *   node scripts/app-source-hash.mjs --json
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { appExcludes, appInputs, productFromArgs, root } from "./products.mjs";

function walk(target, out, excludes) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    out.push(target);
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const child = join(target, entry.name);
    // `sep` keeps `.../tests` from also excluding a hypothetical `tests2`.
    if (excludes.some((excluded) => child.startsWith(excluded))) continue;
    walk(child, out, excludes);
  }
}

/**
 * @param {{product?: object, root?: string}} [options]
 * @returns {string} `v4:<sha256>` over every included path and its bytes.
 */
export function appSourceHash({ product = productFromArgs([]), root: dir = root } = {}) {
  const files = [];
  const excludes = appExcludes().map((path) => join(dir, path) + sep);
  for (const input of appInputs(product)) walk(join(dir, input), files, excludes);
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    const name = relative(dir, file).split(sep).join("/");
    digest.update(name);
    digest.update("\0");
    // Normalize line endings so the Linux gate and a Windows build agree,
    // while leaving binaries (icons) byte-for-byte.
    const bytes = readFileSync(file);
    digest.update(
      bytes.includes(0) ? bytes : bytes.toString("utf8").replace(/\r\n/g, "\n"),
    );
    digest.update("\0");
  }
  return `v4:${digest.digest("hex")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const product = productFromArgs();
  const hash = appSourceHash({ product });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ product: product.id, sourceHash: hash }));
  } else {
    console.log(hash);
  }
}
