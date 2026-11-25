#!/usr/bin/env node
/**
 * Manage the patch stack: the small edits to upstream Chromium files that the
 * overlay cannot avoid (a registration list, a `.grd` entry, a build dependency).
 *
 *   node browser/tools/patch.mjs list
 *   node browser/tools/patch.mjs add side-panel-entry -- chrome/browser/BUILD.gn
 *   node browser/tools/patch.mjs apply
 *
 * Why a stack of numbered patches and not a merge: the danger on a Chromium
 * upgrade is not a conflict, it is a hunk that applies cleanly and is
 * semantically wrong. Numbered patches are individually readable and
 * revertable; `verify.mjs` fails as soon as one stops applying, which is the
 * moment to look at it.
 *
 * The overlay is for new paths only. Anything this tool captures is an edit to
 * an existing file, and it should stay a handful of lines.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, note, ok, parseArgs, parseSeries, patchesDir, run, srcDir, step, treeRoot, warn } from "./lib.mjs";

const SERIES = join(patchesDir, "series");

function readSeries() {
  if (!existsSync(SERIES)) return [];
  return parseSeries(readFileSync(SERIES, "utf8")).map((entry) => entry.file);
}

async function isApplied(src, file) {
  const result = await run("git", ["-C", src, "apply", "--check", "--reverse", file], { allowFail: true });
  return result.code === 0;
}

async function list(src) {
  const series = readSeries();
  if (series.length === 0) {
    note("no patches (browser/patches/series is empty)");
    return 0;
  }
  for (const file of series) {
    const full = join(patchesDir, file);
    if (!existsSync(full)) {
      console.log(`${fail("missing")} ${file}`);
      continue;
    }
    const applied = await isApplied(src, full);
    console.log(`${applied ? ok("applied  ") : warn("pending  ")} ${file}`);
  }
  return 0;
}

async function add(src, slug, paths) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error(fail("usage: patch.mjs add <kebab-case-slug> [-- paths...]"));
    return 1;
  }

  // --binary so an icon replacement round-trips: `git apply` handles a binary
  // hunk natively, and the alternative for the in-product logos is a path the
  // grit resources will not resolve (see docs/browser-branding.md).
  const diff = await run("git", ["-C", src, "diff", "HEAD", "--binary", "--no-color", "--", ...(paths.length ? paths : ["."])], {
    allowFail: true,
  });
  if (diff.code !== 0) {
    console.error(fail(diff.out.trim()));
    return 1;
  }
  if (!diff.out.trim()) {
    console.error(fail("no changes to capture (git diff HEAD is empty)"));
    console.error("  new files belong in browser/overlay/src/hook/, not in a patch");
    return 1;
  }

  mkdirSync(patchesDir, { recursive: true });
  const existing = readdirSync(patchesDir).filter((name) => /^\d{4}-.*\.patch$/.test(name)).sort();
  const next = String((existing.length ? Number.parseInt(existing.at(-1).slice(0, 4), 10) : 0) + 1).padStart(4, "0");
  const name = `${next}-${slug}.patch`;
  writeFileSync(join(patchesDir, name), diff.out.endsWith("\n") ? diff.out : `${diff.out}\n`);

  const series = readSeries();
  series.push(name);
  writeFileSync(
    SERIES,
    `# Chromium patches, applied in this order. Kept deliberately small: see\n# docs/browser-architecture.md, "Why a rebase and not a merge".\n${series.join("\n")}\n`,
  );

  console.log(`${ok("Captured.")} browser/patches/${name}`);
  note("commit it with the change it belongs to; verify.mjs checks it still applies");
  return 0;
}

async function apply(src) {
  const series = readSeries();
  let applied = 0;
  for (const file of series) {
    const full = join(patchesDir, file);
    if (!existsSync(full)) {
      console.error(fail(`browser/patches/${file} is listed but missing`));
      return 1;
    }
    if (await isApplied(src, full)) {
      note(`already applied: ${file}`);
      continue;
    }
    const result = await run("git", ["-C", src, "apply", full], { allowFail: true });
    if (result.code !== 0) {
      console.error(fail(`${file} does not apply:\n${result.out.trim()}`));
      console.error("  upstream moved. Read the hunk, fix it, and re-capture with `patch.mjs add`.");
      return 1;
    }
    note(`applied: ${file}`);
    applied++;
  }
  console.log(`${ok("Done.")} ${applied} patch${applied === 1 ? "" : "es"} applied`);
  return 0;
}

export async function main(argv) {
  const { flags, rest } = parseArgs(argv);
  const root = treeRoot(flags);
  const src = srcDir(root);
  if (!existsSync(join(src, "chrome", "VERSION"))) {
    console.error(fail(`${src} is not a Chromium checkout. Run node browser/tools/sync.mjs first.`));
    return 1;
  }

  const [command, ...args] = rest;
  if (command === "list") return list(src);
  if (command === "add") return add(src, args[0], args.slice(1));
  if (command === "apply") {
    step("applying browser/patches/series");
    return apply(src);
  }

  console.error("usage: patch.mjs <list|add|apply> [--root <dir>]");
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
