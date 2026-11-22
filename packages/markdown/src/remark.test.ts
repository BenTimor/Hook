import test from "node:test";
import assert from "node:assert/strict";

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";

import { documentBreaks, documentDirectives } from "./remark.ts";

/**
 * The read view, end to end: the same remark pipeline `DocumentMarkdown` hands
 * to react-markdown, rendered to HTML. No DOM is needed, and the assertions are
 * about the tree a document becomes, which is what "it renders properly" means.
 */
async function render(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(documentDirectives)
    .use(documentBreaks)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}

test("a rule becomes its element and class", async () => {
  assert.equal(await render(":red[red] :mark[m] :kbd[Ctrl]"), '<p><span class="hook-color-red">red</span> <mark class="hook-mark">m</mark> <kbd class="hook-kbd">Ctrl</kbd></p>');
});

test("markdown inside a label is markdown", async () => {
  assert.equal(
    await render(":red[a **b** c]"),
    '<p><span class="hook-color-red">a <strong>b</strong> c</span></p>',
  );
});

test("a callout is a block with a title and its body", async () => {
  assert.equal(
    await render(":::note[Heads up]\nBody with **bold**.\n:::"),
    '<div class="hook-callout hook-callout-note"><p class="hook-callout-title">Heads up</p><p>Body with <strong>bold</strong>.</p></div>',
  );
});

test("a callout with no label gets the rule's word", async () => {
  assert.match(await render(":::warning\nx\n:::"), /<p class="hook-callout-title">Warning<\/p>/);
});

test("callouts nest, and hold lists, tables and rules", async () => {
  const html = await render(
    ["::::note[Outer]", "Outer body.", "", ":::tip[Inner]", "- a :mark[b]", ":::", "", "Back.", "::::"].join("\n"),
  );
  assert.match(html, /<div class="hook-callout hook-callout-note">/);
  assert.match(html, /<div class="hook-callout hook-callout-tip">/);
  assert.match(html, /<mark class="hook-mark">b<\/mark>/);
  assert.equal(html.match(/hook-callout hook-callout-note/g)?.length, 1);
  assert.equal(html.match(/hook-callout hook-callout-tip/g)?.length, 1);
});

test("a callout inside a blockquote and a list item is still a callout", async () => {
  assert.match(
    await render("> :::note[x]\n> body\n> :::"),
    /<blockquote>\s*<div class="hook-callout hook-callout-note">/,
  );
  assert.match(
    await render("- item\n\n  :::note[x]\n  body\n  :::"),
    /<li>\s*<p>item<\/p>\s*<div class="hook-callout hook-callout-note">/,
  );
});

test("an unknown word is left exactly as typed", async () => {
  assert.equal(await render("a :reed[typo] b"), "<p>a :reed[typo] b</p>");
  assert.equal(await render("a :note[x] b"), "<p>a :note[x] b</p>");
  assert.equal(await render("a :red[] b"), "<p>a :red[] b</p>");
  assert.equal(await render("the port :red is free"), "<p>the port :red is free</p>");
});

test("an unknown block keeps its body and shows its fences", async () => {
  const html = await render(":::nope[x]\nbody\n:::");
  assert.match(html, /:::nope\[x\]/);
  assert.match(html, /<p>body<\/p>/);
  assert.doesNotMatch(html, /hook-callout/);
});

test("raw HTML is text, never an element", async () => {
  assert.equal(await render("a <b>bold</b> word"), "<p>a &#x3C;b>bold&#x3C;/b> word</p>");
  assert.equal(await render("<div>block</div>"), "<p>&#x3C;div>block&#x3C;/div></p>");
});

test("a single newline is a line break, not a space", async () => {
  // The formatted editor draws the document's own lines, so the page has to
  // keep them: a document's rows at the bottom are not a list and not a table.
  assert.equal(await render("1 - 5\n2 - 3\n3 - 6"), "<p>1 - 5<br>\n2 - 3<br>\n3 - 6</p>");
});

test("a continuation line inside a list item keeps its line", async () => {
  assert.equal(await render("1. title\nbody"), "<ol>\n<li>title<br>\nbody</li>\n</ol>");
});

test("a blank line is still a paragraph, and a hard break is not doubled", async () => {
  assert.equal(await render("a\n\nb"), "<p>a</p>\n<p>b</p>");
  assert.equal(await render("a  \nb"), "<p>a<br>\nb</p>");
});

test("a line break inside a directive label draws, and code is untouched", async () => {
  assert.match(await render(":red[a\nb]"), /class="hook-color-red">a<br>\nb<\/span>/);
  assert.equal(await render("```\na\nb\n```"), "<pre><code>a\nb\n</code></pre>");
});

test("a colon-only line inside a code fence still closes the callout", async () => {
  // Upstream: micromark closes a container at any line of colons, fence or not
  // (remarkjs/remark-directive#25). The editor draws what this produces, and
  // `docs` teach the workaround: give the callout more colons than the sample.
  const html = await render(":::note[Fenced]\n```\n:::\n```\nAfter.\n:::");
  assert.equal(html.match(/hook-callout-note/g)?.length, 1);
  const safe = await render("::::note[Fenced]\n```\n:::\n```\nAfter.\n::::");
  assert.match(safe, /<p>After.<\/p>/);
});
