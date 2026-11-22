import test from "node:test";
import assert from "node:assert/strict";

import { blockConstructs, firstLine, parseInline, readTree } from "./parse.ts";
import { ruleFor } from "./rules.ts";

/** Rendered text of an inline parse: every construct hides its own markup. */
function visible(text: string): string {
  const cuts = parseInline(text)
    .flatMap((construct) =>
      construct.kind === "replace"
        ? [{ from: construct.from, to: construct.to }]
        : [
            { from: construct.from, to: construct.openTo },
            { from: construct.closeFrom, to: construct.to },
          ],
    )
    .sort((left, right) => left.from - right.from);
  let out = "";
  let at = 0;
  for (const cut of cuts) {
    if (cut.to <= at) continue;
    out += text.slice(at, cut.from);
    at = Math.max(at, cut.to);
  }
  return out + text.slice(at);
}

function directives(text: string) {
  return parseInline(text).filter((construct) => construct.rule);
}

// ── The envelope ─────────────────────────────────────────────────────────────

test("an inline rule carries its whole span and both pieces of markup", () => {
  const text = "a :red[red here] b";
  const [construct, ...rest] = directives(text);
  assert.equal(rest.length, 0);
  assert.equal(construct.rule?.className, "hook-color-red");
  assert.equal(text.slice(construct.from, construct.to), ":red[red here]");
  assert.equal(text.slice(construct.openTo, construct.closeFrom), "red here");
  assert.equal(construct.openTo, construct.from + ":red[".length);
});

test("aliases select the same rule", () => {
  assert.equal(directives(":highlight[x]")[0].rule?.className, "hook-mark");
  assert.equal(directives(":mark[x]")[0].rule?.className, "hook-mark");
  assert.equal(directives(":u[x]")[0].rule?.className, "hook-underline");
  assert.equal(directives(":underline[x]")[0].rule?.className, "hook-underline");
});

test("a label can hold markdown, and the inner constructs are kept", () => {
  const text = "x :red[a **bold** b] y";
  const constructs = parseInline(text);
  assert.equal(constructs.length, 2);
  assert.equal(constructs[0].rule?.className, "hook-color-red");
  assert.equal(constructs[1].className, "cm-strong");
  assert.equal(visible(text), "x a bold b y");
});

test("nested rules keep both", () => {
  const text = ":red[outer :mark[inner] outer]";
  const constructs = directives(text);
  assert.deepEqual(
    constructs.map((construct) => construct.rule?.className),
    ["hook-color-red", "hook-mark"],
  );
});

test("a label may cross a line break", () => {
  const text = "a :red[one\ntwo] b";
  const [construct] = directives(text);
  assert.equal(text.slice(construct.openTo, construct.closeFrom), "one\ntwo");
});

test("an attribute block is markup, not content", () => {
  const text = ":red[a]{title=b}";
  const [construct] = directives(text);
  assert.equal(text.slice(construct.openTo, construct.closeFrom), "a");
  assert.equal(text.slice(construct.from, construct.to), text);
});

// ── What must stay literal ───────────────────────────────────────────────────

test("an unknown word is not a rule", () => {
  assert.equal(directives(":reed[typo]").length, 0);
});

test("a block word in a sentence is not a rule", () => {
  assert.equal(directives("Version :note[x] here").length, 0);
  assert.equal(ruleFor("note", "inline"), null);
  assert.notEqual(ruleFor("note", "block"), null);
});

test("an empty label is not a rule", () => {
  assert.equal(directives("the port :red is free").length, 0);
  assert.equal(directives("the port :red[] is free").length, 0);
  assert.equal(directives("the port :red[ ] is free").length, 0);
});

test("prose that looks like a directive keeps every character", () => {
  const prose = [
    "At 10:30 AM we left.",
    "Run it on localhost:8080 first.",
    "http://localhost:8000",
    "I watched re:zero all night.",
    "NYSE:SHEL went up.",
    "Use sum(A1:A10) for that.",
    "See DOI:10.1000/xyz123 for more.",
    "John 15:13 says so.",
    "Mitglieder:innen",
    "Ratio 3:4 looks fine.",
    "Version :note is a block word",
    "Version :note[1] here.",
  ];
  for (const line of prose) assert.equal(visible(line), line, line);
});

test("raw html is not rendered and not hidden", () => {
  const text = "a <u>under</u> b";
  assert.equal(parseInline(text).length, 0);
  assert.equal(visible(text), text);
});

test("an unterminated label is ordinary text", () => {
  assert.equal(directives("a :red[never closed").length, 0);
});

// ── Markdown's own constructs ────────────────────────────────────────────────

test("emphasis, strong, code, strike and links are constructs of their own", () => {
  const text = "**b** *i* ~~s~~ `c` [l](https://x.dev)";
  const classes = parseInline(text)
    .filter((construct) => construct.kind === "style")
    .map((construct) => construct.className);
  assert.deepEqual(classes, ["cm-strong", "cm-em", "cm-strike", "cm-code", "cm-link"]);
  assert.equal(visible(text), "b i s c l");
});

test("a link keeps its label, not its address", () => {
  const [link] = parseInline("[label](https://x.dev)");
  assert.equal(link.href, "https://x.dev/");
  assert.equal(link.openTo, 1);
});

test("an image is replaced rather than drawn", () => {
  const [image] = parseInline("![alt](https://x.dev/a.png)");
  assert.equal(image.kind, "replace");
  assert.deepEqual(image.image, { src: "https://x.dev/a.png", alt: "alt" });
});

test("escapes and code spans stay literal", () => {
  assert.equal(directives("`` `:red[x]` ``").length, 0);
  assert.equal(visible("**a \\* b**"), "a \\* b");
});

// ── Blocks ───────────────────────────────────────────────────────────────────

test("a callout block is found with its title", () => {
  const [block] = blockConstructs(":::note[Heads up]\nbody\n:::");
  assert.equal(block.name, "note");
  assert.equal(block.rule.className, "hook-callout hook-callout-note");
  assert.equal(block.title, "Heads up");
});

test("a callout with no label falls back to the rule's word", () => {
  assert.equal(blockConstructs(":::warning\nbody\n:::")[0].title, "Warning");
});

test("callouts nest and stay separate", () => {
  const blocks = blockConstructs("::::note[Outer]\n:::tip[Inner]\nx\n:::\n::::");
  assert.deepEqual(blocks.map((block) => block.title), ["Outer", "Inner"]);
});

test("a block word inside code is not a callout", () => {
  assert.equal(blockConstructs("```\n:::note[x]\n```").length, 0);
});

test("nobody has to read the tree by hand", () => {
  const tree = readTree(":::note[x]\ny\n:::");
  assert.equal(tree.children?.[0].type, "containerDirective");
});

// ── Excerpts ─────────────────────────────────────────────────────────────────

test("an excerpt drops markup but keeps words", () => {
  assert.equal(firstLine("## Title **here**"), "Title here");
  assert.equal(firstLine(":::note[Heads up]\nbody\n:::"), "Heads up");
  assert.equal(firstLine("- [ ] a :red[task]"), "a task");
  assert.equal(firstLine("\n\n> quoted *line*"), "quoted line");
});
