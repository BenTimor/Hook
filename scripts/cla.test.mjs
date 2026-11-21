import assert from "node:assert/strict";
import test from "node:test";
import {
  addSignature,
  hasSigned,
  isExempt,
  isSigningComment,
  parseSignatures,
  SIGNING_PHRASE,
} from "./cla.mjs";

// The gate decides whether a pull request can merge. A false "signed" would put
// code into the tree that the commercial license can never cover, and that is
// not fixable after the fact — so these are the tests that matter most.

test("the exact phrase is a signature", () => {
  assert.equal(isSigningComment(SIGNING_PHRASE), true);
});

test("wrapping and quoting the phrase still signs", () => {
  // People paste it out of the bot's instructions, which quote it.
  assert.equal(isSigningComment(`> ${SIGNING_PHRASE}`), true);
  assert.equal(isSigningComment(`  ${SIGNING_PHRASE}  `), true);
  assert.equal(isSigningComment(`"${SIGNING_PHRASE}"`), true);
  assert.equal(isSigningComment(SIGNING_PHRASE.toLowerCase()), true);
});

test("a phrase with anything added is not a signature", () => {
  assert.equal(isSigningComment(`${SIGNING_PHRASE} but I do not agree`), false);
  assert.equal(isSigningComment(`${SIGNING_PHRASE}?`), false);
  assert.equal(isSigningComment("sign the cla"), false);
  assert.equal(isSigningComment(""), false);
  assert.equal(isSigningComment(undefined), false);
  assert.equal(isSigningComment(null), false);
});

test("the owner and bots never need to sign", () => {
  assert.equal(isExempt("BenTimor", "BenTimor"), true);
  assert.equal(isExempt("dependabot[bot]", "BenTimor"), true);
  assert.equal(isExempt("github-actions[bot]", "BenTimor"), true);
  assert.equal(isExempt("some-human", "BenTimor"), false);
});

test("the allowlist is honoured and is exact", () => {
  assert.equal(isExempt("colleague", "BenTimor", ["colleague"]), true);
  // A partial or case-mismatched login must not slip through.
  assert.equal(isExempt("colleague-evil", "BenTimor", ["colleague"]), false);
  assert.equal(isExempt("COLLEAGUE", "BenTimor", ["colleague"]), false);
});

test("a missing or damaged signatures file means nobody has signed", () => {
  assert.deepEqual(parseSignatures(null), { version: 1, signed: [] });
  assert.deepEqual(parseSignatures(""), { version: 1, signed: [] });
  assert.deepEqual(parseSignatures("{ not json"), { version: 1, signed: [] });
  assert.deepEqual(parseSignatures("null"), { version: 1, signed: [] });
  assert.deepEqual(parseSignatures('{"signed":"nope"}'), { version: 1, signed: [] });
});

test("signatures round-trip and match case-insensitively", () => {
  const empty = parseSignatures(null);
  const once = addSignature(empty, "Octocat", "2026-01-01T00:00:00Z");
  assert.equal(hasSigned(once, "Octocat"), true);
  assert.equal(hasSigned(once, "octocat"), true);
  assert.equal(hasSigned(once, "someone"), false);

  const restored = parseSignatures(JSON.stringify(once));
  assert.deepEqual(restored, once);
});

test("signing twice does not duplicate the entry", () => {
  const once = addSignature(parseSignatures(null), "Octocat", "2026-01-01T00:00:00Z");
  const twice = addSignature(once, "Octocat", "2026-02-02T00:00:00Z");
  assert.equal(twice.signed.length, 1);
  assert.equal(twice.signed[0].signedAt, "2026-01-01T00:00:00Z");
});

test("junk entries are dropped rather than trusted", () => {
  const parsed = parseSignatures(
    JSON.stringify({ signed: [{ login: "a" }, { login: 7 }, {}, null, { login: "b" }] }),
  );
  assert.deepEqual(
    parsed.signed.map((e) => e.login),
    ["a", "b"],
  );
});
