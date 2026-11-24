#!/usr/bin/env node
/**
 * Fails when a dependency is under a license Hook cannot ship.
 *
 * Hook is AGPL-3.0-only and is dual-licensed commercially, so the rule is
 * simple: every dependency must be permissively licensed, or weak-copyleft that
 * the AGPL can absorb (MPL-2.0, and OFL for the bundled fonts). Strong copyleft,
 * source-available licenses and anything unrecognised are a hard stop, because
 * they would decide Hook's license for it.
 *
 *   node scripts/check-licenses.mjs
 *   node scripts/check-licenses.mjs --verbose
 *
 * Covers both trees:
 *   - npm, by reading node_modules/.pnpm (run `pnpm install` first)
 *   - Rust, by asking `cargo metadata` for the resolved graph in Cargo.lock
 *
 * This is a report, not legal advice. A green run means nothing changed;
 * a new dependency still needs a look at THIRD_PARTY_NOTICES.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose");

/**
 * Permissive, or compatible with the AGPL without touching Hook's own terms.
 * Keys are the identifiers as they appear after normalisation.
 */
const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "Zlib",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "CDLA-Permissive-2.0",
  "Python-2.0",
  "BSL-1.0",
  "WTFPL",
  "Public Domain",
  // Weak copyleft: file-level. The AGPL can absorb it, and it imposes nothing
  // on Hook's own source beyond keeping those files' notices intact.
  "MPL-2.0",
  "OFL-1.1",
  "OFL-1.1-no-RFN",
  "LGPL-2.1",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
]);

/**
 * Identifiers that stop the run. These are not in ALLOWED, so they already
 * cannot satisfy an expression; the list exists so a rejection can say why.
 */
const DENIED = [
  ["AGPL-3.0", "network copyleft would force this dependency's terms onto Hook"],
  ["AGPL-1.0", "network copyleft"],
  ["GPL-3.0", "strong copyleft"],
  ["GPL-2.0", "strong copyleft; only safe as a separate, unlinked executable"],
  ["SSPL-1.0", "source-available, not open source"],
  ["BUSL-1.1", "source-available, not open source"],
  ["Elastic-2.0", "source-available, not open source"],
  ["Commons-Clause", "no-sell restriction"],
  ["CC-BY-NC", "non-commercial restriction"],
  ["CC-BY-SA", "share-alike applies to derivative works"],
  ["EUPL-1.2", "strong copyleft"],
  ["OSL-3.0", "strong copyleft"],
  ["CPAL-1.0", "strong copyleft"],
  ["RSE", "reciprocal source, not open source"],
  ["JSON", "the JSON license's 'Good, not Evil' clause is non-free"],
  ["NPL-1.1", "strong copyleft"],
  ["Sleepycat", "strong copyleft"],
];

/**
 * Documented exceptions, by name. Add an entry only with a reason and a note in
 * THIRD_PARTY_NOTICES.md — this file is what a reviewer reads to know why an
 * odd license is present.
 */
const EXCEPTIONS = new Map([
  // ["some-package", "GPL-2.0-only ships as a separate executable; see MinGit."],
]);

/** Collapse the spellings the ecosystem uses into one identifier. */
function normalise(raw) {
  if (!raw) return "UNKNOWN";
  let s = String(raw).trim();
  s = s.replace(/^SEE LICENSES? IN .*$/i, "UNKNOWN");
  s = s.replace(/Public Domain/i, "Public-Domain");
  s = s.replace(/\*/g, "");
  s = s.replace(/\//g, " OR "); // "MIT/Apache-2.0" -> "MIT OR Apache-2.0"
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Parse a SPDX expression into a tree. `AND` binds tighter than `OR`, and
 * parentheses override both — `(MIT OR Apache-2.0) AND Unicode-3.0` is the
 * case that a naive split gets wrong.
 */
function parse(expression) {
  const tokens = expression.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter(Boolean);
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  function parseOr() {
    let node = parseAnd();
    while (peek() && /^OR$/i.test(peek())) {
      take();
      node = { op: "OR", left: node, right: parseAnd() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseTerm();
    while (peek() && /^AND$/i.test(peek())) {
      take();
      node = { op: "AND", left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    const token = take();
    if (token === "(") {
      const node = parseOr();
      if (peek() === ")") take();
      return node;
    }
    if (!token) return { op: "LICENSE", id: "UNKNOWN" };
    let id = token;
    if (peek() && /^WITH$/i.test(peek())) {
      take();
      id = `${id} WITH ${take()}`;
    }
    return { op: "LICENSE", id };
  }

  return parseOr();
}

/** Walk the tree: OR is satisfied by any branch, AND by every branch. */
function satisfied(expression) {
  function evaluate(node) {
    if (node.op === "LICENSE") {
      if (ALLOWED.has(node.id)) return true;
      const [base] = node.id.split(/\s+WITH\s+/i);
      return ALLOWED.has(base);
    }
    if (node.op === "OR") return evaluate(node.left) || evaluate(node.right);
    if (node.op === "AND") return evaluate(node.left) && evaluate(node.right);
    return false;
  }
  return evaluate(parse(expression));
}

/** Every license identifier in an expression, in order. */
function collectTerms(node, out = []) {
  if (node.op === "LICENSE") out.push(node.id);
  else {
    collectTerms(node.left, out);
    collectTerms(node.right, out);
  }
  return out;
}

/**
 * The first denied identifier in the expression, for the error message only.
 * The decision is `satisfied()`: a term that is not in ALLOWED is unusable, so
 * `MIT OR GPL-3.0-only` is fine (you take MIT) while `MIT AND GPL-3.0-only` is
 * not. DENIED exists to explain *why* a package was rejected.
 */
function deniedTerm(expression) {
  for (const term of collectTerms(parse(expression))) {
    for (const [id, why] of DENIED) {
      if (
        term === id ||
        term.startsWith(`${id}-`) ||
        term.startsWith(`${id}+`)
      ) {
        return { term, why };
      }
    }
  }
  return null;
}

/** The project's own crates and packages: their license is the point. */
const OWN_PACKAGE =
  /^(@hook\/|hook(-core|-workspace|-mobile|-host)?@|tauri-plugin-google-signin@|tauri-plugin-mobile-shell@)/;

/** Returns null when fine, or a reason string. */
function checkOne(name, license) {
  if (EXCEPTIONS.has(name)) return null;
  if (OWN_PACKAGE.test(name)) return null;
  if (!license) return "no license declared";
  const expression = normalise(license);
  if (expression === "UNKNOWN" || /^UNLICENSED$/i.test(expression)) {
    return "no license declared";
  }
  if (satisfied(expression)) return null;
  const denied = deniedTerm(expression);
  if (denied) return `${license} — ${denied.why}`;
  return `${license} is not on the allowlist`;
}

/** Every package pnpm installed, keyed by name@version. */
function npmPackages() {
  const store = join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) {
    throw new Error(
      "node_modules/.pnpm is missing — run `pnpm install` before this check.",
    );
  }
  const found = new Map();
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modules = join(store, entry.name, "node_modules");
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      if (name.startsWith(".")) continue;
      const dirs = name.startsWith("@")
        ? readdirSync(join(modules, name)).map((s) => join(modules, name, s))
        : [join(modules, name)];
      for (const dir of dirs) {
        try {
          const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          const license =
            typeof meta.license === "string"
              ? meta.license
              : meta.license?.type ??
                (Array.isArray(meta.licenses)
                  ? meta.licenses.map((l) => l.type).join(" OR ")
                  : null);
          found.set(`${meta.name}@${meta.version}`, license);
        } catch {
          // A package without readable metadata is pnpm's business, not ours.
        }
      }
    }
  }
  return found;
}

/** Every crate in the resolved graph, via cargo's own view of the lockfile. */
function cargoPackages() {
  let raw;
  try {
    raw = execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    throw new Error(`cargo metadata failed: ${error.message}`);
  }
  const meta = JSON.parse(raw);
  const found = new Map();
  for (const pkg of meta.packages) {
    found.set(`${pkg.name}@${pkg.version}`, pkg.license ?? null);
  }
  return found;
}

function report(label, packages) {
  const problems = [];
  for (const [name, license] of packages) {
    const reason = checkOne(name, license);
    if (reason) problems.push({ name, reason });
  }
  if (verbose) {
    const counts = new Map();
    for (const [, license] of packages) {
      const key = normalise(license);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    console.log(`${label}: ${packages.size} packages`);
    for (const [license, count] of sorted) console.log(`  ${count}\t${license}`);
    if (problems.length === 0) console.log("");
  }
  return problems;
}

const failures = [];
function main() {
  for (const [label, load] of [
    ["npm", npmPackages],
    ["cargo", cargoPackages],
  ]) {
    let packages;
    try {
      packages = load();
    } catch (error) {
      console.error(`license check: ${label}: ${error.message}`);
      process.exit(1);
    }
    const problems = report(label, packages);
    if (problems.length > 0) {
      failures.push([label, problems]);
    } else {
      console.log(`license check: ${label} ok (${packages.size} packages)`);
    }
  }

  if (failures.length > 0) {
    console.error("\nlicense check: FAILED\n");
    for (const [label, problems] of failures) {
      console.error(`${label}:`);
      for (const { name, reason } of problems) {
        console.error(`  ${name}\n    ${reason}`);
      }
    }
    console.error(
      "\nHook is AGPL-3.0-only and dual-licensed. A dependency it cannot ship\n" +
        "decides Hook's license for it. Either drop the dependency, or add it to\n" +
        "EXCEPTIONS in scripts/check-licenses.mjs *and* THIRD_PARTY_NOTICES.md\n" +
        "with a reason a reviewer can check.",
    );
    process.exit(1);
  }

  console.log(
    "license check: all dependencies are compatible with AGPL-3.0-only",
  );
}

// Only run when invoked directly; the tests import the pure functions above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { ALLOWED, DENIED, EXCEPTIONS, checkOne, normalise, parse, satisfied };
