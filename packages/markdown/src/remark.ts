import { ruleFor, type Rule } from "./rules.ts";
import { isDirectiveLabel, type MdastNode } from "./parse.ts";

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
 */
export function documentDirectives() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : "";
    rewrite(tree, source);
  };
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
        node.data = { ...node.data, hName: "div", hProperties: { className: rule.className } };
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
