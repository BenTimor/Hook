import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs, parseChromeVersion, parsePinnedTag, parseSeries, requiredSdkVersion } from "./lib.mjs";
import { listFiles, inspectOverlay, overlayCopies } from "./verify.mjs";

function workspace() {
  return mkdtempSync(join(tmpdir(), "hook-browser-"));
}

// --------------------------------------------------------------- browser/VERSION --

test("a pinned tag is four numbers and nothing else", () => {
  assert.equal(parsePinnedTag("159.0.8154.13\n"), "159.0.8154.13");
  assert.equal(parsePinnedTag("  159.0.8154.13  "), "159.0.8154.13");
});

test("a malformed pin is rejected instead of reaching gclient", () => {
  // `gclient config ...@159` would silently check out a branch head, so the
  // tools refuse anything that is not a tag.
  for (const bad of ["159", "159.0", "159.0.8154", "v159.0.8154.13", "", "159.0.8154.13-rc1"]) {
    assert.throws(() => parsePinnedTag(bad), /Chromium tag/, `accepted ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------------------- chrome/VERSION --

const CHROME_VERSION = ["MAJOR=159", "MINOR=0", "BUILD=8154", "PATCH=13"].join("\n");

test("the checkout's own version is read from chrome/VERSION", () => {
  assert.equal(parseChromeVersion(CHROME_VERSION), "159.0.8154.13");
  assert.equal(parseChromeVersion(`${CHROME_VERSION}\r\n`), "159.0.8154.13");
});

test("a chrome/VERSION without all four fields is an error, not a wrong answer", () => {
  assert.throws(() => parseChromeVersion("MAJOR=159\nMINOR=0\nBUILD=8154"), /PATCH/);
});

test("the SDK the tree pins comes from the tree", () => {
  const root = workspace();
  mkdirSync(join(root, "src", "build"), { recursive: true });
  writeFileSync(
    join(root, "src", "build", "vs_toolchain.py"),
    "TOOLCHAIN_HASH = '3bfcb536c8'\nSDK_VERSION = '10.0.28000.0'\n",
  );
  assert.equal(requiredSdkVersion(root), "10.0.28000.0");
  assert.equal(requiredSdkVersion(join(root, "elsewhere")), null);
});

// ------------------------------------------------------------------- patches --

test("series ignores comments and blank lines", () => {
  const series = parseSeries("# title\n\n0001-one.patch\n  0002-two.patch  \n");
  assert.deepEqual(
    series.map((entry) => entry.file),
    ["0001-one.patch", "0002-two.patch"],
  );
});

// ------------------------------------------------------------ overlay rule --

test("an overlay file that upstream already has is a copy", () => {
  // This is the rule that keeps the overlay from becoming a merged fork: the
  // only allowed overlap is our own namespace, which //hook resolves to.
  const files = ["hook/browser/tab_model.cc", "hook/browser/README.md", "chrome/browser/tab_strip.cc", "build/config/win/x.gni"];
  const upstream = new Set(["chrome/browser/tab_strip.cc", "build/config/win/x.gni"]);
  assert.deepEqual(overlayCopies(files, (rel) => upstream.has(rel)), [
    "chrome/browser/tab_strip.cc",
    "build/config/win/x.gni",
  ]);
});

test("a new path is never reported as a copy", () => {
  assert.deepEqual(overlayCopies(["hook/a.cc", "build/config/win/hook.gni"], () => false), []);
});

test("overlay files are listed as sorted POSIX paths", () => {
  const dir = workspace();
  mkdirSync(join(dir, "hook", "browser"), { recursive: true });
  writeFileSync(join(dir, "hook", "browser", "tab_model.cc"), "");
  writeFileSync(join(dir, "hook", "README.md"), "");
  assert.deepEqual(listFiles(dir), ["hook/README.md", "hook/browser/tab_model.cc"]);
  assert.deepEqual(listFiles(join(dir, "missing")), []);
});

// `browser/overlay/src` mirrors the checkout's `src`, so the comparison has to
// start there. Walking `browser/overlay` compares against `src/src/...` instead
// and silently never finds a copy — which is the one failure this check exists
// for.
test("the overlay is compared from overlay/src, not from the overlay root", () => {
  const overlaySrc = join(workspace(), "overlay", "src");
  const src = join(workspace(), "chromium", "src");
  mkdirSync(join(overlaySrc, "hook"), { recursive: true });
  mkdirSync(join(overlaySrc, "chrome", "browser"), { recursive: true });
  mkdirSync(join(src, "chrome", "browser"), { recursive: true });
  writeFileSync(join(overlaySrc, "hook", "tab_model.cc"), "");
  writeFileSync(join(overlaySrc, "chrome", "browser", "tab_strip.cc"), "");
  writeFileSync(join(src, "chrome", "browser", "tab_strip.cc"), "");

  const { files, copies } = inspectOverlay(overlaySrc, src);
  assert.deepEqual(files, ["chrome/browser/tab_strip.cc", "hook/tab_model.cc"]);
  assert.deepEqual(copies, ["chrome/browser/tab_strip.cc"]);
});

// --------------------------------------------------------------------- argv --

test("flags parse as --name value, --name=value and --switch", () => {
  const { flags, rest } = parseArgs(["--root", "C:\\Dev\\cr", "--jobs=2", "--gen-only", "add", "slug"], {
    switches: ["gen-only"],
  });
  assert.equal(flags.get("root"), "C:\\Dev\\cr");
  assert.equal(flags.get("jobs"), "2");
  assert.equal(flags.get("gen-only"), true);
  assert.deepEqual(rest, ["add", "slug"]);
});

test("everything after -- is a path, even if it looks like a flag", () => {
  const { flags, rest } = parseArgs(["add", "my-fix", "--", "--weird-name.cc", "b.cc"]);
  assert.equal(flags.has("weird-name.cc"), false);
  assert.deepEqual(rest, ["add", "my-fix", "--weird-name.cc", "b.cc"]);
});
