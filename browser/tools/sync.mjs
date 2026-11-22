#!/usr/bin/env node
/**
 * Materialise the Chromium tree at browser/VERSION and wire our overlay into it.
 *
 *   node browser/tools/sync.mjs [--root C:\Dev\cr] [--jobs 2] [--retries 6]
 *
 * The checkout lives outside the repository (see lib.mjs), `src/hook` is a
 * junction into `browser/overlay/src/hook` so editing the overlay edits the
 * bytes Chromium compiles, and `hook/` is added to the checkout's git exclude so
 * Chromium's own `git status` stays clean.
 *
 * Two things about `gclient sync --no-history` are learned the hard way:
 *
 *   - fetching ~100 deps shallow in parallel trips Google's anonymous rate limit
 *     (`429 RESOURCE_EXHAUSTED`), so this throttles to two jobs and retries;
 *   - a dep that loses that race keeps a `.git` with no checkout, after which
 *     gclient considers it healthy forever and the build fails hours later. Each
 *     retry finds and removes those, which is the only in-place recovery.
 *
 * Never run `gclient sync -D` here: once `src/hook` is a junction it can delete
 * it, and it removes unmanaged directories.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserDir,
  bold,
  depotToolsBin,
  fail,
  findBrokenDeps,
  findDepotTools,
  linkJunction,
  note,
  ok,
  overlayDir,
  parseArgs,
  readPinnedTag,
  resolvesTo,
  run,
  sdkStatus,
  srcDir,
  step,
  treeRoot,
  warn,
  detectVisualStudio,
} from "./lib.mjs";

const GCLIENT_TEMPLATE = join(browserDir, ".gclient.in");

function writeGclient(root, tag) {
  const target = join(root, ".gclient");
  const rendered = readFileSync(GCLIENT_TEMPLATE, "utf8").replaceAll("__TAG__", tag);
  if (existsSync(target) && readFileSync(target, "utf8") === rendered) return false;
  writeFileSync(target, rendered);
  return true;
}

/**
 * Chromium reports every file it does not know about. The overlay is one of
 * them, and a 20 000-entry `git status` hides a real mistake.
 */
function excludeOverlay(root) {
  const exclude = join(srcDir(root), ".git", "info", "exclude");
  if (!existsSync(exclude)) return;
  const text = readFileSync(exclude, "utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes("hook/") || lines.includes("/hook/")) return;
  writeFileSync(exclude, `${text.replace(/\s*$/, "")}\nhook/\n`);
}

export async function main(argv) {
  const { flags } = parseArgs(argv);
  const root = treeRoot(flags);
  const jobs = flags.get("jobs") ?? "2";
  const retries = Number(flags.get("retries") ?? 6);

  const tag = readPinnedTag();
  step(`Chromium ${bold(tag)} into ${root}`);

  const depotTools = findDepotTools(flags);
  if (!depotTools) {
    console.error(fail("depot_tools not found."));
    console.error("  git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git C:\\Dev\\depot_tools");
    console.error("  ...then add it to PATH, or pass --depot-tools <dir>");
    return 1;
  }
  note(`depot_tools: ${depotTools}`);

  const env = { ...process.env, PATH: `${depotTools}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` };
  // External developers build with the Visual Studio on the machine; the
  // downloadable toolchain is Googlers-only.
  env.DEPOT_TOOLS_WIN_TOOLCHAIN = "0";

  const vs = await detectVisualStudio();
  if (vs) {
    env[vs.variable] = vs.path;
    note(`visual studio: ${vs.path} (${vs.variable})`);
  }

  mkdirSync(root, { recursive: true });
  if (writeGclient(root, tag)) note("wrote .gclient");

  const gclient = depotToolsBin(depotTools, "gclient");
  for (let attempt = 1; attempt <= retries; attempt++) {
    step(`gclient sync --no-history (attempt ${attempt}/${retries}, --jobs ${jobs})`);
    const result = await run(gclient, ["sync", "--no-history", "--jobs", String(jobs)], {
      cwd: root,
      env,
      capture: false,
      allowFail: true,
    });
    if (result.code === 0) break;

    if (attempt === retries) {
      console.error(fail(`gclient sync failed ${retries} times; giving up.`));
      return 1;
    }

    const broken = await findBrokenDeps(root);
    if (broken.length === 0) {
      note(warn("retrying in 60s"));
      await new Promise((done) => setTimeout(done, 60_000));
      continue;
    }
    for (const dir of broken) {
      note(warn(`removing half-fetched dep ${dir}`));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------ wiring --
  if (existsSync(overlayDir)) {
    const link = join(srcDir(root), "hook");
    mkdirSync(dirname(overlayDir), { recursive: true });
    if (resolvesTo(link, overlayDir)) {
      note("overlay junction: already in place");
    } else {
      if (existsSync(link)) {
        console.error(fail(`${link} exists but does not point at ${overlayDir}; move it aside and re-run.`));
        return 1;
      }
      await linkJunction(link, overlayDir);
      note(`overlay junction: ${link} -> ${overlayDir}`);
    }
    excludeOverlay(root);
  } else {
    note(warn("browser/overlay/src/hook does not exist yet; skipping the junction"));
  }

  // -------------------------------------------------------------- toolchain --
  const sdk = sdkStatus(root);
  if (process.platform === "win32" && sdk.required && !sdk.hasHeaders) {
    console.log();
    console.log(warn(`This tag needs Windows SDK ${sdk.required}, which is not installed.`));
    console.log(`  expected: ${sdk.include}`);
    console.log("  winget install Microsoft.WindowsSDK." + sdk.required.replace(/\.0$/, ""));
    console.log(warn("  and it must include the \"Debugging Tools for Windows\" feature (dbghelp.dll)."));
  } else if (process.platform === "win32" && sdk.required && !sdk.hasDebuggers) {
    console.log(warn(`SDK ${sdk.required} is installed without the Debugging Tools feature; gn gen will fail on dbghelp.dll.`));
  } else if (process.platform === "win32" && sdk.required) {
    note(`windows sdk: ${sdk.required} ${ok("ok")}`);
  }

  console.log();
  console.log(`${ok("Tree ready.")} Next: node browser/tools/verify.mjs && node browser/tools/build.mjs`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
