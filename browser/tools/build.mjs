#!/usr/bin/env node
/**
 * Generate and build the stock `chrome` target in a synced tree.
 *
 *   node browser/tools/build.mjs [--root C:\Dev\cr] [--out out/Dev] [--target chrome]
 *   node browser/tools/build.mjs --gen-only          # just gn gen
 *
 * `browser/args.gn` is copied into the build directory first, so the dev
 * configuration is one file in the repository rather than a flag someone has to
 * remember. Symbol levels are part of it on purpose: changing them after the
 * first build forces a full recompile.
 *
 * Build `chrome`, never `all` — `all` drags in every test binary.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserDir,
  bold,
  depotToolsBin,
  detectVisualStudio,
  fail,
  findDepotTools,
  note,
  ok,
  parseArgs,
  readPinnedTag,
  run,
  sdkStatus,
  srcDir,
  step,
  treeRoot,
} from "./lib.mjs";

const ARGS_FILE = join(browserDir, "args.gn");

export async function main(argv) {
  const { flags } = parseArgs(argv, { switches: ["gen-only"] });
  const root = treeRoot(flags);
  const outRel = flags.get("out") ?? "out/Dev";
  const target = flags.get("target") ?? "chrome";
  const genOnly = flags.get("gen-only") === true;

  const src = srcDir(root);
  if (!existsSync(join(src, "chrome", "VERSION"))) {
    console.error(fail(`${src} is not a Chromium checkout. Run node browser/tools/sync.mjs first.`));
    return 1;
  }

  const sdk = sdkStatus(root);
  if (process.platform === "win32" && sdk.required) {
    if (!sdk.hasHeaders) {
      console.error(fail(`Chromium ${readPinnedTag()} requires Windows SDK ${sdk.required}; not found at ${sdk.include}.`));
      console.error("  winget install Microsoft.WindowsSDK." + sdk.required.replace(/\.0$/, ""));
      return 1;
    }
    if (!sdk.hasDebuggers) {
      console.error(fail(`SDK ${sdk.required} is installed without "Debugging Tools for Windows"; gn gen needs dbghelp.dll.`));
      return 1;
    }
  }

  const depotTools = findDepotTools(flags);
  if (!depotTools) {
    console.error(fail("depot_tools not found; pass --depot-tools <dir> or put it on PATH."));
    return 1;
  }

  const env = {
    ...process.env,
    PATH: `${depotTools}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    DEPOT_TOOLS_WIN_TOOLCHAIN: "0",
  };
  const vs = await detectVisualStudio();
  if (vs) {
    // build/vs_toolchain.py only probes %ProgramFiles% for VS 2022, while
    // BuildTools installs under Program Files (x86); without this override gn
    // reports "No supported Visual Studio can be found".
    env[vs.variable] = vs.path;
  }

  const out = resolve(join(src, outRel));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "args.gn"), readFileSync(ARGS_FILE, "utf8"));

  const gn = existsSync(join(src, "buildtools", "win", "gn.exe"))
    ? join(src, "buildtools", "win", "gn.exe")
    : depotToolsBin(depotTools, "gn");

  step(`gn gen ${bold(outRel)}`);
  const generated = await run(gn, ["gen", outRel], { cwd: src, env, capture: false, allowFail: true });
  if (generated.code !== 0) {
    console.error(fail("gn gen failed."));
    return generated.code || 1;
  }

  if (genOnly) {
    console.log(`${ok("Generated.")} ${join(out, "args.gn")}`);
    return 0;
  }

  step(`autoninja -C ${bold(outRel)} ${bold(target)}`);
  note("first build is hours; incremental builds are minutes");
  const built = await run(depotToolsBin(depotTools, "autoninja"), ["-C", outRel, target], {
    cwd: src,
    env,
    capture: false,
    allowFail: true,
  });
  if (built.code !== 0) {
    console.error(fail(`build failed (${built.code}).`));
    return built.code || 1;
  }

  const binary = join(out, process.platform === "win32" ? "chrome.exe" : target);
  console.log();
  console.log(`${ok("Built.")} ${binary}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
