import { ruleFor, type Rule } from "./rules.ts";
import { isDirectiveLabel, type MdastNode } from "./parse.ts";
import { META_NAME } from "./meta.ts";

/**
 * The read view's half of the dialect.
 *
 * `remark-directive` parses `:red[…]` and `:::note[…]` into nodes that nothing
 * knows how to draw yet. This plugin turns a registered name into the element
 * and the class the registry names, and leaves everything else exactly as it
 * was typed: an unknown word, an empty label and raw HTML are all shown
 * literally, so a typo never silently eats a paragraph.
 *
 * The one exception is a registered name with nothing inside it. `:red` alone in
 * a sentence is prose — "the port :red is free" — not an empty run.
 *
 * The metadata line `::meta{direction=rtl}` is the other: it is the document's
 * own setting, not a paragraph, so it leaves the tree without a trace.
 */
export function documentDirectives() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : "";
    rewrite(tree, source);
  };
}

/**
 * A single newline stays a line break.
 *
 * CommonMark calls `a\nb` a soft break and draws it as a space, while the
 * formatted editor draws the document's own lines — so a page that collapsed
 * them read as one run-on line, and the rows at the bottom of a document
 * (`1 - 5`, `2 - 3`, … written without pipes or bullets) came out as
 * "1 - 5 2 - 3 3 - 6". A blank line is still a new paragraph (a separate node,
 * untouched), and two trailing spaces are still Markdown's own hard break.
 *
 * Runs after `documentDirectives`, so every directive is still measured against
 * its own position in the source before any text node is split.
 */
export function documentBreaks() {
  return (tree: MdastNode) => {
    breakLines(tree);
  };
}

function breakLines(node: MdastNode) {
  const children = node.children;
  if (!children) return;

  let index = 0;
  while (index < children.length) {
    const child = children[index];
    if (child.type !== "text" || !child.value?.includes("\n")) {
      breakLines(child);
      index += 1;
      continue;
    }
    const lines = child.value.split("\n");
    const pieces: MdastNode[] = [];
    for (let at = 0; at < lines.length; at += 1) {
      if (at > 0) pieces.push({ type: "break" });
      if (lines[at]) pieces.push({ type: "text", value: lines[at] });
    }
    children.splice(index, 1, ...pieces);
    index += pieces.length;
  }
}

const PHRASING = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "textDirective",
]);

function rewrite(parent: MdastNode, source: string) {
  const children = parent.children;
  if (!children) return;

  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const literal = typeof start === "number" && typeof end === "number" ? source.slice(start, end) : "";

    // The metadata line is the document's setting, not its text: the one at
    // the top is never drawn. A `::meta` further down is a word nobody
    // registered, and reads as the text it is, like any other unknown word.
    const top = node.position?.start.line === 1;
    if (node.name === META_NAME && node.type === "leafDirective" && top) {
      children.splice(index, 1);
      index -= 1;
      continue;
    }

    switch (node.type) {
      case "textDirective": {
        const inner = node.children ?? [];
        const rule = ruleFor(node.name, "inline");
        if (!rule || inner.length === 0 || !literalText(node).trim()) {
          children[index] = { type: "text", value: literal };
          break;
        }
        node.data = { ...node.data, hName: rule.element, hProperties: { className: rule.className } };
        rewrite(node, source);
        break;
      }
      case "containerDirective":
      case "leafDirective": {
        const rule = ruleFor(node.name, "block");
        rewrite(node, source);
        if (!rule) {
          index += unwrapUnknown(node, children, index, literal);
          break;
        }
        node.data = {
          ...node.data,
          hName: rule.element,
          hProperties: rule.dir
            ? { className: rule.className, dir: rule.dir }
            : { className: rule.className },
        };
        // A direction wrapper is not a box: it flips what it holds and has no
        // heading of its own.
        if (rule.dir) break;
        ensureTitle(node, rule);
        break;
      }
      case "html": {
        // Without `rehype-raw` an html node would vanish, taking its content
        // with it. Show what was typed instead: lossless, and clearly wrong.
        children[index] = {
          type: PHRASING.has(parent.type) ? "text" : "paragraph",
          value: PHRASING.has(parent.type) ? literal : undefined,
          children: PHRASING.has(parent.type) ? undefined : [{ type: "text", value: literal }],
        };
        break;
      }
      default:
        rewrite(node, source);
    }
  }
}

/** A block word with no rule: keep the body, show both fences as text. */
function unwrapUnknown(
  node: MdastNode,
  siblings: MdastNode[],
  index: number,
  literal: string,
): number {
  const lines = literal.split("\n");
  const head: MdastNode = { type: "paragraph", children: [{ type: "text", value: lines[0] ?? "" }] };
  const body = node.type === "containerDirective" ? node.children ?? [] : [];
  const closing = body.length > 0 && lines.length > 1 ? lines[lines.length - 1] : "";
  const tail: MdastNode[] = /^:{3,}\s*$/.test(closing.trim())
    ? [{ type: "paragraph", children: [{ type: "text", value: closing }] }]
    : [];
  const replacement = [head, ...body, ...tail];
  siblings.splice(index, 1, ...replacement);
  return replacement.length - 1;
}

/** Every callout reads as a heading, even a hand-written fence with no label. */
function ensureTitle(node: MdastNode, rule: Rule) {
  const children = node.children ?? (node.children = []);
  const head = children.find(isDirectiveLabel);
  if (head) {
    if (!literalText(head).trim()) head.children = [{ type: "text", value: rule.defaultLabel ?? "" }];
    head.type = "paragraph";
    head.data = { ...head.data, hProperties: { className: "hook-callout-title" } };
    return;
  }
  children.unshift({
    type: "paragraph",
    data: { hProperties: { className: "hook-callout-title" } },
    children: [{ type: "text", value: rule.defaultLabel ?? "" }],
  });
}

function literalText(node: MdastNode): string {
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(literalText).join("");
}
