import test from "node:test";
import assert from "node:assert/strict";

import { copyableMarkdown } from "./copy.ts";

/**
 * What Copy puts on the clipboard for a reply. A direction marker is structure
 * and is never drawn, so it must not travel with the message either; everything
 * else is the text that was written.
 */

test("a direction wrapper copies as the lines inside it", () => {
  assert.equal(copyableMarkdown(":::rtl\nשלום, עולם\n:::"), "שלום, עולם");
  assert.equal(copyableMarkdown("before\n:::ltr\nHello\n:::\nafter"), "before\nHello\nafter");
});

test("the top line's direction is not part of the message", () => {
  assert.equal(copyableMarkdown("::meta{direction=rtl}\n# שלום"), "# שלום");
  assert.equal(copyableMarkdown("::meta{direction=ltr}\nHello"), "Hello");
});

test("a meta line below the top is words, so it is copied as words", () => {
  assert.equal(copyableMarkdown("# Hello\n::meta{direction=rtl}"), "# Hello\n::meta{direction=rtl}");
});

test("a callout keeps its own fences when a wrapper's come off", () => {
  const body = [":::rtl", ":::note[อ่านก่อน]", "content", ":::", ":::"].join("\n");
  assert.equal(copyableMarkdown(body), [":::note[อ่านก่อน]", "content", ":::"].join("\n"));
  // The other order too: the callout is the last thing opened, so it is the
  // last one closed.
  const nested = [":::note[Title]", ":::rtl", "سطر", ":::", ":::"].join("\n");
  assert.equal(copyableMarkdown(nested), [":::note[Title]", "سطر", ":::"].join("\n"));
});

test("a fenced code block is text, whatever is on its lines", () => {
  const markdown = [":::rtl", "```text", ":::rtl", ":::", ":::", "```"].join("\n");
  assert.equal(copyableMarkdown(markdown), ["```text", ":::rtl", ":::", ":::", "```"].join("\n"));
});

test("a fence in ordinary prose is not a marker", () => {
  assert.equal(copyableMarkdown("a ::: b"), "a ::: b");
  assert.equal(copyableMarkdown(":::note is a word here"), ":::note is a word here");
  assert.equal(copyableMarkdown("    :::rtl\n    text"), "    :::rtl\n    text");
});

test("an unclosed wrapper loses its opening and keeps the rest", () => {
  assert.equal(copyableMarkdown(":::rtl\nשלום"), "שלום");
  // A stray closing fence has no marker to belong to, so it stays as typed.
  assert.equal(copyableMarkdown("text\n:::"), "text\n:::");
});

test("a message with no direction is copied exactly", () => {
  const markdown = ["# Title", "", "- one", "- two", "", "Some :red[colour] and **bold**."].join("\n");
  assert.equal(copyableMarkdown(markdown), markdown);
});
