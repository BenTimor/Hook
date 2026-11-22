#!/usr/bin/env node
/**
 * Check that the tree is what `browser/VERSION` says and that we have not
 * silently become a merged fork.
 *
 *   node browser/tools/verify.mjs [--root C:\Dev\cr]
 *
 * Three rules, all of which fail loudly:
 *
 *   1. The checkout's `chrome/VERSION` matches the pinned tag.
 *   2. The overlay contains new paths only. A file under `overlay/src/` that
 *      also exists upstream is a copy of a Chromium file, which is the failure
 *      mode the overlay exists to prevent: copies go stale and nobody knows
 *      which of them still matter. Upstream behaviour changes belong in
 *      `patches/`, where they are visible, reviewable and fail on a rebase.
 *   3. Every patch in `patches/series` applies — or is already applied.
 *
 * It also checks the wiring: `src/hook` pointing at the overlay, and `hook/` in
 * the checkout's git exclude.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fail,
  note,
  ok,
  overlayDir,
  parseArgs,
  parseSeries,
  patchesDir,
  readChromeVersion,
  readPinnedTag,
  resolvesTo,
  run,
  srcDir,
  step,
  treeRoot,
  warn,
} from "./lib.mjs";

/** Every file under `dir`, as POSIX paths relative to it. */
export function listFiles(dir) {
  const files = [];
  function walk(current, prefix) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  }
  if (existsSync(dir)) walk(dir, "");
  return files.sort();
}

/**
 * A copy is an overlay file that upstream also has. Paths under `hook/` are our
 * own namespace (`//hook` resolves there), so they are never copies.
 */
export function overlayCopies(files, upstreamHas) {
  return files.filter((rel) => rel !== "hook" && !rel.startsWith("hook/") && upstreamHas(rel));
}

/**
 * Compare `browser/overlay/src` with the checkout's `src`. The two mirror each
 * other, so a relative path is comparable as-is; walking from `browser/overlay`
 * instead would compare against `src/src/...` and never find a copy.
 */
export function inspectOverlay(overlaySrc, src) {
  const files = listFiles(overlaySrc);
  return { files, copies: overlayCopies(files, (rel) => existsSync(join(src, rel))) };
}

export async function main(argv) {
  const { flags } = parseArgs(argv);
  const root = treeRoot(flags);
  const src = srcDir(root);
  const problems = [];

  if (!existsSync(join(src, "chrome", "VERSION"))) {
    console.error(fail(`${src} is not a Chromium checkout. Run node browser/tools/sync.mjs first.`));
    return 1;
  }

  const pinned = readPinnedTag();
  step(`browser/VERSION ${pinned} vs ${src}`);

  const actual = readChromeVersion(root);
  if (actual === pinned) {
    note(`chrome/VERSION: ${actual} ${ok("match")}`);
  } else {
    problems.push(`tree is ${actual ?? "unknown"}, browser/VERSION says ${pinned}`);
  }

  // ------------------------------------------------------------------ overlay --
  const { files, copies } = inspectOverlay(join(overlayDir, ".."), src);
  if (files.length === 0) {
    note(warn("overlay is empty (Steps 1+ of docs/browser-poc-plan.md are not written)"));
  } else if (copies.length === 0) {
    note(`overlay: ${files.length} new path${files.length === 1 ? "" : "s"}, no upstream copies ${ok("ok")}`);
  } else {
    for (const rel of copies) problems.push(`overlay/src/${rel} also exists upstream — patch it instead of copying it`);
  }

  // ------------------------------------------------------------------ patches --
  const seriesPath = join(patchesDir, "series");
  const patches = existsSync(seriesPath) ? parseSeries(readFileSync(seriesPath, "utf8")) : [];
  for (const patch of patches) {
    const file = join(patchesDir, patch.file);
    if (!existsSync(file)) {
      problems.push(`patches/series lists ${patch.file}, which does not exist`);
      continue;
    }
    // Reverse first: a tree that already has the patch applied must not be
    // reported as broken, or verify fails right after a successful apply.
    const applied = await run("git", ["-C", src, "apply", "--check", "--reverse", file], { allowFail: true });
    if (applied.code === 0) continue;
    const applies = await run("git", ["-C", src, "apply", "--check", file], { allowFail: true });
    if (applies.code !== 0) problems.push(`patches/${patch.file} does not apply to this tree`);
  }
  if (patches.length > 0) note(`patches: ${patches.length} in series ${ok("ok")}`);

  // ------------------------------------------------------------------- wiring --
  const link = join(src, "hook");
  if (!existsSync(overlayDir)) {
    note(warn("no overlay directory; junction not checked"));
  } else if (resolvesTo(link, overlayDir)) {
    note(`junction: src/hook -> overlay/src/hook ${ok("ok")}`);
  } else {
    problems.push(`src/hook is not a junction to browser/overlay/src/hook (run sync.mjs)`);
  }

  const exclude = join(src, ".git", "info", "exclude");
  if (existsSync(exclude) && !/^\s*hook\/\s*$/m.test(readFileSync(exclude, "utf8"))) {
    problems.push("src/.git/info/exclude does not list hook/ (run sync.mjs)");
  }

  console.log();
  if (problems.length === 0) {
    console.log(ok("Verify passed."));
    return 0;
  }
  for (const problem of problems) console.error(fail(`- ${problem}`));
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
