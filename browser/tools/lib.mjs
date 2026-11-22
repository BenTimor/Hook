#!/usr/bin/env node
/**
 * Shared plumbing for the Hook Browser tooling.
 *
 * The Chromium checkout is a build environment, not part of this repository: it
 * is ~100 GB with its own `.git`, `git clean -xfd` would destroy a multi-hour
 * fetch, and its `third_party/...` paths hit `MAX_PATH` under a deep root. So
 * everything here works on a tree that lives somewhere else (`C:\Dev\cr` by
 * default) and is pointed at it, rather than assuming it is a sibling.
 *
 * What is exported is deliberately the parsing and the shell plumbing only: the
 * tools themselves are thin, so the risky part (deleting a dep directory,
 * creating a junction) is in one place that can be tested.
 */
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const browserDir = join(repoRoot, "browser");
export const overlayDir = join(browserDir, "overlay", "src", "hook");
export const patchesDir = join(browserDir, "patches");

/**
 * A short root, by Chromium's own guidance. Overridable so the tools are not
 * welded to one machine: `--root <dir>` wins over `HOOK_CHROMIUM_ROOT`.
 */
export const defaultRoot =
  process.env.HOOK_CHROMIUM_ROOT ??
  (process.platform === "win32" ? "C:\\Dev\\cr" : join(homedir(), "cr"));

// ---------------------------------------------------------------- reporting --

const isTty = process.stdout.isTTY === true;
const paint = (code) => (text) => (isTty ? `\u001b[${code}m${text}\u001b[0m` : text);
export const ok = paint("32");
export const warn = paint("33");
export const fail = paint("31");
export const bold = paint("1");

export function step(message) {
  console.log(`${bold("==>")} ${message}`);
}

export function note(message) {
  console.log(`    ${message}`);
}

// --------------------------------------------------------------------- argv --

/**
 * Tiny flag parser: `--name value`, `--name=value` and `--switch` all work.
 * Anything else is collected in `rest`, so `patch.mjs add my-fix -- a.cc b.cc`
 * keeps its paths.
 *
 * A switch has to be declared, because `--root C:\\Dev\\cr` and `--gen-only
 * chrome` are indistinguishable otherwise — the first takes a value, the second
 * does not, and guessing turns a build into a silent no-op.
 */
export function parseArgs(argv, options = {}) {
  const switches = new Set(options.switches ?? []);
  const flags = new Map();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (!switches.has(name) && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, true);
    }
  }
  return { flags, rest };
}

// --------------------------------------------------------------------- tree --

export function treeRoot(flags) {
  const root = typeof flags.get("root") === "string" ? flags.get("root") : defaultRoot;
  return resolve(root);
}

/** `C:\Dev\cr` as a Chromium checkout keeps it: `.gclient` at the root, `src`. */
export function srcDir(root) {
  return join(root, "src");
}

/**
 * The tag is the only thing that decides what the tree contains, so it lives in
 * its own file: the sync script reads it, the release ritual changes it, and a
 * `git diff` of one line is the whole "which Chromium is this" answer.
 */
export function readPinnedTag() {
  return parsePinnedTag(readFileSync(join(browserDir, "VERSION"), "utf8"));
}

export function parsePinnedTag(text) {
  const tag = String(text).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`browser/VERSION must be a Chromium tag like 159.0.8154.13, got ${JSON.stringify(tag)}`);
  }
  return tag;
}

/**
 * `chrome/VERSION` inside the checkout, which is what the tree actually is.
 * Reading it beats asking git: a `--no-history` clone has no tags, so
 * `git describe` cannot answer and `git rev-parse <tag>` needs the network.
 */
export function readChromeVersion(root) {
  try {
    const text = readFileSync(join(srcDir(root), "chrome", "VERSION"), "utf8");
    return parseChromeVersion(text);
  } catch {
    return null;
  }
}

export function parseChromeVersion(text) {
  const fields = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Z]+)=(\d+)$/.exec(line.trim());
    if (m) fields.set(m[1], m[2]);
  }
  for (const key of ["MAJOR", "MINOR", "BUILD", "PATCH"]) {
    if (!fields.has(key)) throw new Error(`chrome/VERSION is missing ${key}`);
  }
  return `${fields.get("MAJOR")}.${fields.get("MINOR")}.${fields.get("BUILD")}.${fields.get("PATCH")}`;
}

// ------------------------------------------------------------- toolchains --

/** The SDK version this tree insists on, read from the tree itself, not guessed. */
export function requiredSdkVersion(root) {
  try {
    const text = readFileSync(join(srcDir(root), "build", "vs_toolchain.py"), "utf8");
    const m = /^SDK_VERSION = '([^']+)'/m.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function sdkRoot() {
  const kits = process.env.WINDOWSSDKDIR;
  if (kits) return kits;
  const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return join(programFiles, "Windows Kits", "10");
}

/**
 * M159 pins the SDK version in two places and `base/win/windows_version.cc`
 * refuses to compile without `NTDDI_WIN11_BR`, so "any SDK will do" is wrong and
 * the failure arrives as a confusing C++ error. Check it up front instead.
 *
 * The Debugging Tools feature matters too: `gn gen` runs `copy_dlls`, which
 * needs `Windows Kits\10\Debuggers\<cpu>\dbghelp.dll`.
 */
export function sdkStatus(root) {
  const required = requiredSdkVersion(root);
  if (!required) return { required: null, include: null, hasHeaders: false, hasDebuggers: false };
  const kits = sdkRoot();
  const include = join(kits, "Include", required);
  const debuggers = join(kits, "Debuggers", "x64", "dbghelp.dll");
  return {
    required,
    include,
    hasHeaders: existsSync(include),
    hasDebuggers: existsSync(debuggers),
  };
}

/**
 * Visual Studio's version decides the override variable's name (`vs2022_install`,
 * `vs2026_install`). The override itself is what makes VS 2022 BuildTools work:
 * `build/vs_toolchain.py` only probes `%ProgramFiles%` for 2022, and BuildTools
 * installs under `Program Files (x86)`.
 */
export async function detectVisualStudio() {
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) return null;

  const path = await run(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], {
    allowFail: true,
  });
  const version = await run(vswhere, ["-latest", "-products", "*", "-property", "installationVersion"], {
    allowFail: true,
  });
  if (path.code !== 0 || !path.out.trim()) return null;

  const major = Number.parseInt(version.out.trim().split(".")[0] ?? "", 10);
  const year = { 18: "2026", 17: "2022", 16: "2019", 15: "2017" }[major];
  return year ? { path: path.out.trim(), year, variable: `vs${year}_install` } : null;
}

/** depot_tools' launchers are `.bat` on Windows, so resolve through PATHEXT. */
export function which(command) {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");

  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export function findDepotTools(flags) {
  const explicit = flags.get("depot-tools");
  if (typeof explicit === "string") return resolve(explicit);

  const gclient = which("gclient");
  if (gclient) return dirname(gclient);

  for (const candidate of ["C:\\Dev\\depot_tools", join(homedir(), "depot_tools")]) {
    if (existsSync(join(candidate, "gclient"))) return candidate;
    if (existsSync(join(candidate, "gclient.bat"))) return candidate;
  }
  return null;
}

export function depotToolsBin(depotTools, name) {
  const candidates =
    process.platform === "win32" ? [join(depotTools, `${name}.bat`), join(depotTools, name)] : [join(depotTools, name)];
  return candidates.find((candidate) => existsSync(candidate)) ?? name;
}

// -------------------------------------------------------------------- shell --

function quoteWin(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Run a command and either stream it (long builds want a console) or capture
 * it. On Windows everything goes through `cmd.exe`, because the tools we drive —
 * `gclient`, `autoninja`, `python3` — are `.bat` launchers and Node refuses to
 * spawn those directly.
 */
export function run(command, args = [], options = {}) {
  const { cwd, env, capture = true, allowFail = false, echo = false } = options;
  const quoted = [command, ...args].map((arg) => (process.platform === "win32" ? quoteWin(arg) : arg));
  const printable = quoted.join(" ");
  if (echo) note(`$ ${printable}`);

  const child =
    process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${quoted.join(" ")}"`], {
          cwd,
          env: env ?? process.env,
          stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
          windowsVerbatimArguments: true,
        })
      : spawn(command, args, {
          cwd,
          env: env ?? process.env,
          stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        });

  return new Promise((resolvePromise) => {
    let out = "";
    if (capture) {
      child.stdout?.on("data", (chunk) => (out += chunk));
      child.stderr?.on("data", (chunk) => (out += chunk));
    }
    child.on("error", (error) => {
      if (allowFail) resolvePromise({ code: -1, out: String(error.message) });
      else throw error;
    });
    child.on("close", (code) => {
      if (code !== 0 && !allowFail) {
        const error = new Error(`\`${printable}\` exited ${code}\n${out.trim()}`);
        error.exitCode = code;
        error.output = out;
        throw error;
      }
      resolvePromise({ code, out });
    });
  });
}

// ----------------------------------------------------------------- deps/tree --

/**
 * A dep that lost a fetch race keeps a `.git` with no HEAD. gclient then treats
 * the directory as healthy and never re-fetches it, and the build dies much
 * later with "missing and no known rule to make it". Finding them is the only
 * way to recover without wiping the tree.
 */
export async function findBrokenDeps(root, maxDepth = 5) {
  const broken = [];
  const skip = new Set([".git", "out", "node_modules", "hook"]);

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGit = entries.some((entry) => entry.name === ".git" && entry.isDirectory());
    if (hasGit) {
      const head = await run("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], { allowFail: true });
      if (head.code !== 0) broken.push(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(srcDir(root), 0);
  return broken;
}

/** True when `path` exists and resolves to `target` — how a junction is checked. */
export function resolvesTo(path, target) {
  try {
    if (!lstatSync(path)) return false;
    const a = realpathSync(path).toLowerCase();
    const b = realpathSync(target).toLowerCase();
    return a === b;
  } catch {
    return false;
  }
}

/**
 * Point `link` at `target` with a directory junction (Windows) or a symlink
 * elsewhere. A junction rather than a copy is the whole reason the overlay can
 * be edited in the repository and compiled in the checkout at once; it needs no
 * elevation, unlike a symlink.
 */
export function linkJunction(link, target) {
  return new Promise((resolvePromise, rejectPromise) => {
    const [file, args] =
      process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "mklink", "/J", link, target]]
        : ["ln", ["-s", target, link]];
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (out += chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`could not create ${link}: ${out.trim()}`));
    });
  });
}

// ------------------------------------------------------------------ patches --

/**
 * `series` is a list of patch file names, in the order they must apply. Blank
 * lines and `#` comments are ignored so a patch can carry a title.
 */
export function parseSeries(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((file) => ({ file }));
}
