import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RULES, canonical } from "./rules.ts";

/**
 * The reference a model is handed by the `document_markdown` tool is
 * `docs/document-markdown.md`, embedded into the Rust core; this file is the
 * same syntax the editor and the read view implement. A rule that exists here
 * and not there is a rule the agent will never use, so it fails the build
 * instead of shipping.
 */
const reference = readFileSync(
  fileURLToPath(new URL("../../../docs/document-markdown.md", import.meta.url)),
  "utf8",
);

function spelled(rule: (typeof RULES)[number]): boolean {
  return rule.names.some((name) =>
    rule.scope === "inline" ? reference.includes(`:${name}[`) : reference.includes(`:::${name}`),
  );
}

test("the reference names every rule the parser accepts", () => {
  for (const rule of RULES) {
    assert.ok(spelled(rule), `docs/document-markdown.md never shows ${canonical(rule)}`);
  }
});

test("the reference shows the aliases, so neither spelling looks like a typo", () => {
  for (const rule of RULES.filter((candidate) => candidate.names.length > 1)) {
    for (const name of rule.names) {
      assert.ok(
        reference.includes(`:${name}[`),
        `the alias :${name} for ${canonical(rule)} is missing from the reference`,
      );
    }
  }
});

test("the reference explains the nesting rule and the literal cases", () => {
  // The two things a model gets wrong without being told: how to nest a
  // callout, and that raw HTML is text rather than formatting.
  assert.match(reference, /one more colon/i);
  assert.match(reference, /raw html/i);
  assert.match(reference, /literal/i);
});
