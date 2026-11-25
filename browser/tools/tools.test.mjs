import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs, parseChromeVersion, parsePinnedTag, parseSeries, requiredSdkVersion } from "./lib.mjs";
import { listFiles, inspectOverlay, overlayCopies } from "./verify.mjs";
import { analyseNetLog, componentsProblems, matrixPlan, parseComponentsPage } from "./smoke.mjs";

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

// --no-google is only worth having if it can fail: a check that passes because it
// read nothing, or because it stopped looking, is worse than no check.
test("the Google traffic check separates the updater, preconnects and content", () => {
  const log = [
    '{"params":{"request_info":{"url":"https://update.googleapis.com/service/update2/json"}}}',
    '{"params":{"is_preconnect":true,"url":"https://www.google.com/"}}',
    '{"params":{"request_info":{"url":"https://fonts.gstatic.com/s/googlesans/x.woff2"}}}',
    '{"params":{"request_info":{"url":"https://example.com/fine"}}}',
  ].join(",");
  const traffic = analyseNetLog(log);
  assert.equal(traffic.urls, 4);
  assert.deepEqual([...traffic.allowed.keys()], ["update.googleapis.com"]);
  assert.deepEqual([...traffic.preconnects.keys()], ["www.google.com"]);
  assert.deepEqual(traffic.forbidden, ["https://fonts.gstatic.com/s/googlesans/x.woff2"]);
});

test("an empty net log proves nothing and is reported as such", () => {
  assert.equal(analyseNetLog("").urls, 0);
});

test("a preconnect to Google is not a fetch", () => {
  const traffic = analyseNetLog('{"params":{"is_preconnect":true,"url":"https://www.google.com/search/warmup.html"}}');
  assert.deepEqual(traffic.forbidden, []);
  assert.deepEqual([...traffic.preconnects.keys()], ["www.google.com"]);
});

// --all: the matrix has to be a plan, not a list of flags in a README, and the two
// checks that depend on each other have to say so instead of quietly passing.
test("the matrix runs both sign-in states and both halves of the channel", () => {
  const quiet = matrixPlan({ channelAlive: false });
  assert.deepEqual(
    quiet.map((check) => check.name),
    ["a plain launch", "the surfaces", "signed out", "signed in", "its own host", "the channel"],
  );
  const states = quiet.filter((check) => check.argv.includes("--signin-state")).map((check) => check.argv.join(" "));
  assert.deepEqual(states, ["--signin-state out", "--signin-state in --components"]);
  const surfaces = quiet.find((check) => check.name === "the surfaces");
  for (const flag of ["--side-panel", "--newtab", "--codecs", "--no-google"]) {
    assert.ok(surfaces.argv.includes(flag), `${flag} is in the shared launch`);
  }
});

test("an answering channel skips the launch check and runs the channel check, never both", () => {
  const quiet = matrixPlan({ channelAlive: false });
  const busy = matrixPlan({ channelAlive: true });
  const host = (plan) => plan.find((check) => check.name === "its own host");
  const channel = (plan) => plan.find((check) => check.name === "the channel");
  assert.equal(host(quiet).skip, null);
  assert.match(host(busy).skip, /already answering/);
  assert.match(channel(quiet).skip, /start the Hook app/);
  assert.equal(channel(busy).skip, null);
  // Every check either runs or explains itself: a silent skip reads as a pass.
  for (const check of [...quiet, ...busy]) {
    assert.ok(check.skip !== undefined, `${check.name} has a skip answer`);
    if (check.skip === null) assert.ok(check.argv.length >= 0);
  }
});

// The allowlist is only a claim until something reads it back. `chrome://components`
// is that something, and the parse has to survive the page's own noise ("Components
// (23)", "Status - New collection", the per-row buttons).
test("the components page yields names, not its furniture", () => {
  const page = [
    "Components",
    "Components (2)",
    "CRLSet - Version: 0.0.0.0",
    "Status - New collection",
    "Check for update",
    "File Type Policies - Version: 1.2.3.4",
    "Status - Up-to-date",
  ].join("\n");
  assert.deepEqual(parseComponentsPage(page), ["CRLSet", "File Type Policies"]);
  assert.deepEqual(parseComponentsPage(""), []);
});

test("the signed-in launch is the one that proves the component allowlist", () => {
  const signedIn = matrixPlan({ channelAlive: false }).find((check) => check.name === "signed in");
  assert.ok(signedIn.argv.includes("--components"), "the components check runs signed in, where the gate lets a chrome:// page load");
});

// The tripwire has to bite in both directions, or it is decoration.
test("the allowlist check fails on a stray component and on a missing one", () => {
  assert.deepEqual(componentsProblems(["CRLSet", "PKI Metadata", "File Type Policies"]), []);
  assert.deepEqual(
    componentsProblems(["CRLSet", "PKI Metadata", "File Type Policies", "PKI Metadata Fastpush"]),
    [],
    "the fastpush half of PKI metadata is allowed",
  );
  const stray = componentsProblems(["CRLSet", "PKI Metadata", "File Type Policies", "Optimization Hints"]);
  assert.equal(stray.length, 1);
  assert.match(stray[0], /Optimization Hints.*not on Hook's allowlist/);
  const missing = componentsProblems(["PKI Metadata", "File Type Policies"]);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /CRLSet.*upstream rename/);
  assert.match(componentsProblems([])[0], /listed nothing/);
});
