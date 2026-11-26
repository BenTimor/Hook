import test from "node:test";
import assert from "node:assert/strict";

import { declaredDirection, isMetaLine, metaDirection, metaLine, readDocumentMeta } from "./meta.ts";

/**
 * The document's metadata line: the one line at the very top that says what the
 * document is. Direction is the first thing it carries, and the format has
 * room for more — a reader that does not know a key ignores it.
 */

test("the top line names the direction", () => {
  assert.deepEqual(readDocumentMeta("::meta{direction=rtl}\n# שלום"), { direction: "rtl" });
  assert.deepEqual(readDocumentMeta("::meta{direction=ltr}\n# Hello"), { direction: "ltr" });
});

test("no line, or no direction in it, is left to right", () => {
  assert.deepEqual(readDocumentMeta("# Hello"), { direction: "ltr" });
  assert.deepEqual(readDocumentMeta(""), { direction: "ltr" });
  assert.deepEqual(readDocumentMeta("::meta{}\n# Hello"), { direction: "ltr" });
  assert.deepEqual(readDocumentMeta("::meta{direction=sideways}\n# Hello"), { direction: "ltr" });
});

test("only the top line is metadata", () => {
  assert.deepEqual(readDocumentMeta("# Hello\n::meta{direction=rtl}"), { direction: "ltr" });
});

test("the line survives CRLF, quotes and indentation", () => {
  assert.deepEqual(readDocumentMeta("::meta{direction=rtl}\r\nbody"), { direction: "rtl" });
  assert.deepEqual(readDocumentMeta('  ::meta{direction="rtl"}  \nbody'), { direction: "rtl" });
});

test("a line of ordinary prose is not metadata", () => {
  assert.equal(isMetaLine("::sidebar{direction=rtl}"), false);
  assert.equal(isMetaLine("see ::meta{direction=rtl} above"), false);
  assert.equal(metaDirection("::meta{title=x}"), null);
  assert.equal(isMetaLine("::meta{direction=rtl}"), true);
});

test("the toolbar writes the line it reads", () => {
  assert.equal(metaLine("rtl"), "::meta{direction=rtl}");
  assert.deepEqual(readDocumentMeta(`${metaLine("rtl")}\ntext`), { direction: "rtl" });
});

test("a message that names no direction is left to its own text", () => {
  // A document falls back to left to right; a reply asks the browser instead,
  // so "no line" and "a line that says ltr" must be told apart.
  assert.equal(declaredDirection("# Hello"), null);
  assert.equal(declaredDirection("::meta{}\nHello"), null);
  assert.equal(declaredDirection("::meta{direction=ltr}\nHello"), "ltr");
  assert.equal(declaredDirection("::meta{direction=rtl}\r\nHello"), "rtl");
});

test("the editor's maths is the page's maths", async () => {
  const { renderMath } = await import("./math.ts");
  const inline = renderMath("x^2", false);
  assert.ok(inline && inline.includes("<math"), "inline maths renders as MathML");
  assert.equal(renderMath("\frac{1", true), null, "TeX that does not parse is refused, not thrown");
});
