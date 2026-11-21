import assert from "node:assert/strict";
import test from "node:test";
import { checkOne, normalise, satisfied } from "./check-licenses.mjs";

// Hook is AGPL-3.0-only and dual-licensed. The gate is only worth having if it
// says no to the licenses that would make the second half of that impossible.

test("permissive licenses are accepted", () => {
  for (const license of [
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    "Unlicense",
    "Zlib",
    "Unicode-3.0",
    "BlueOak-1.0.0",
    "CDLA-Permissive-2.0",
    "MPL-2.0",
    "OFL-1.1",
    "LGPL-3.0-only",
  ]) {
    assert.equal(satisfied(normalise(license)), true, license);
  }
});

test("strong copyleft is refused", () => {
  for (const license of ["GPL-3.0-only", "GPL-2.0-only", "AGPL-3.0-only"]) {
    assert.notEqual(
      checkOne("some-dependency@1.0.0", license),
      null,
      `${license} must not be shippable`,
    );
  }
});

test("source-available licenses are refused", () => {
  for (const license of [
    "SSPL-1.0",
    "BUSL-1.1",
    "Elastic-2.0",
    "Commons-Clause",
    "CC-BY-NC-4.0",
  ]) {
    assert.notEqual(
      checkOne("some-dependency@1.0.0", license),
      null,
      `${license} must not be shippable`,
    );
  }
});

test("an undeclared license is refused", () => {
  assert.notEqual(checkOne("mystery@1.0.0", null), null);
  assert.notEqual(checkOne("mystery@1.0.0", ""), null);
  assert.notEqual(checkOne("mystery@1.0.0", "UNLICENSED"), null);
  assert.notEqual(checkOne("mystery@1.0.0", "SEE LICENSE IN LICENSE.txt"), null);
});

test("LGPL is not mistaken for GPL", () => {
  // The word-boundary rule is the whole reason this test exists: a substring
  // match on "GPL" would reject every LGPL crate.
  assert.equal(checkOne("dep@1.0.0", "LGPL-2.1-only"), null);
  assert.equal(checkOne("dep@1.0.0", "LGPL-3.0-or-later"), null);
  assert.notEqual(checkOne("dep@1.0.0", "GPL-3.0-only"), null);
});

test("OR is satisfied by any branch, AND by every branch", () => {
  assert.equal(satisfied("MIT OR GPL-3.0-only"), true, "MIT is enough");
  assert.equal(satisfied("GPL-3.0-only OR AGPL-3.0-only"), false);
  assert.equal(satisfied("MIT AND GPL-3.0-only"), false, "AND needs both");
});

test("parenthesised expressions are parsed, not split", () => {
  // The real crate that broke a naive split (unicode-ident).
  assert.equal(satisfied("(MIT OR Apache-2.0) AND Unicode-3.0"), true);
  // Parentheses flip the meaning. `(MIT OR GPL-3.0-only) AND Unicode-3.0` is
  // still fine — you may take the MIT branch — but an AND that *requires* GPL
  // is not.
  assert.equal(satisfied("(MIT OR GPL-3.0-only) AND Unicode-3.0"), true);
  assert.equal(satisfied("(MIT AND GPL-3.0-only) OR Unicode-3.0"), true);
  assert.equal(satisfied("MIT AND (GPL-3.0-only OR AGPL-3.0-only)"), false);
});

test("WITH exceptions are handled", () => {
  assert.equal(satisfied("Apache-2.0 WITH LLVM-exception"), true);
  assert.equal(satisfied("GPL-2.0-only WITH Classpath-exception-2.0"), false);
});

test("slash spellings are read as OR", () => {
  assert.equal(satisfied(normalise("MIT/Apache-2.0")), true);
  assert.equal(satisfied(normalise("MIT OR Apache-2.0")), true);
});

test("the project's own packages are exempt", () => {
  // Their AGPL is the point; flagging them would make the gate unusable.
  for (const name of [
    "hook-core@0.2.1",
    "hook@0.4.0",
    "hook-workspace@0.1.8",
    "hook-mobile@0.1.0",
    "@hook/chat@0.1.0",
    "@hook/ui@0.1.0",
    "tauri-plugin-google-signin@0.1.0",
    "tauri-plugin-mobile-shell@0.1.0",
  ]) {
    assert.equal(checkOne(name, "AGPL-3.0-only"), null, name);
  }
});

test("a similarly named dependency is still checked", () => {
  // The exemption keys on the package name, so "hooks" must not ride along.
  assert.notEqual(checkOne("hooks@1.0.0", "GPL-3.0-only"), null);
});
