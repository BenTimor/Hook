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
 *
 * Before ninja runs, the dock bundle is rebuilt from `browser/ui/` (Vite, about
 * half a second). It is generated JavaScript and is not committed; `build_webui`
 * can only pack static files that exist in the source tree, and GN cannot express
 * "this output depends on node_modules", so this wrapper is the one place that
 * keeps the two halves in step.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserDir,
  repoRoot,
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

/**
 * Where the browser should start its Hook host from (`docs/browser-host.md`,
 * "Starting it").
 *
 * A packaged browser finds `hook.exe` beside itself and never reads this. A dev
 * tree has no such file, so the path to the repository's binary is written into
 * `out/Dev/args.gn` — computed per machine rather than committed, because
 * `browser/args.gn` has to stay the same file on every checkout. It is resolved
 * once, at build time, which is what keeps the launcher from ever executing a
 * path a page or the environment named; an absent binary just means the browser
 * says it cannot start a host.
 */
function hostArg() {
  // Release first: that is the binary `pnpm app:build` leaves behind, and it is
  // the one that behaves like an installed product's. A debug build works too —
  // the browser names the host's data folder when it launches it, so a
  // `%APPDATA%\hook-dev\` build still publishes where the browser looks.
  const base = join(browserDir, "..", "apps", "chat", "src-tauri", "target");
  const binary = ["release", "debug"]
    .map((kind) => join(base, kind, process.platform === "win32" ? "hook.exe" : "hook"))
    .find((candidate) => existsSync(candidate));
  if (!binary) return "";
  const slash = resolve(binary).replaceAll("\\", "/");
  return `\n# written by browser/tools/build.mjs: the browser starts this host itself\nhook_host_path = "${slash}"\n`;
}

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

  // The bundle before the build: `build_webui` packs `panel.mjs` as a static file
  // and ninja cannot generate it (build_webui resolves static files against the
  // source tree, and GN cannot list node_modules as inputs). Vite takes under a
  // second, so this runs every time rather than trying to be clever about it.
  if (!existsSync(join(repoRoot, "node_modules", "vite"))) {
    console.error(fail("node_modules has no vite; run pnpm install."));
    return 1;
  }
  step("bundling the dock");
  const bundle = await run(
    process.execPath,
    [
      join(browserDir, "tools", "bundle.mjs"),
      "--out",
      join(browserDir, "overlay", "src", "hook", "resources"),
    ],
    { cwd: repoRoot },
  );
  if (bundle.code !== 0) {
    console.error(fail("the dock bundle failed to build"));
    return 1;
  }
  // Vite's exit is not always the end of its handle on Windows: a scanner or the
  // esbuild service can hold the new file for a moment, and ninja's first reader
  // then fails with a sharing violation. Reading it once here is the cheapest
  // way to wait that out.
  {
    const bundlePath = join(browserDir, "overlay", "src", "hook", "resources", "panel.mjs");
    for (let attempt = 0; ; attempt++) {
      try {
        readFileSync(bundlePath, { encoding: "utf8", flag: "r" });
        break;
      } catch (failure) {
        if (attempt >= 20) {
          console.error(fail(`the dock bundle is unreadable: ${failure.message}`));
          return 1;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
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
  const argsGn = readFileSync(ARGS_FILE, "utf8") + hostArg();
  writeFileSync(join(out, "args.gn"), argsGn);

  // A directory built by siso keeps a marker that depot_tools' ninja wrapper
  // refuses to build past. The overlay is a Windows junction, which siso's
  // hashfs cannot read, so args.gn pins ninja; clear the marker and say what
  // switching costs. Siso never wrote ninja's build log, so the first ninja
  // build recompiles the tree even though every output is already on disk.
  if (/^\s*use_siso\s*=\s*false\s*$/m.test(argsGn) && existsSync(join(out, ".siso_deps"))) {
    unlinkSync(join(out, ".siso_deps"));
    note(`cleared the siso marker in ${outRel}: switching to ninja recompiles the tree once`);
  }

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
