import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";

import { ruleFor, type Rule } from "./rules.ts";

/**
 * The one parser of the dialect.
 *
 * The live editor and the read-only renderer disagree the moment they parse
 * separately, so both go through micromark's own directive grammar: the editor
 * runs it over an inline block to place its decorations, `remark.ts` runs it
 * over the whole document (through `remark-directive`) to build the tree that
 * React draws. This module is the editor's half and the tests' reference.
 */

/** The slice of mdast this module reads. Kept local so the package stays API-free. */
export interface MdastNode {
  type: string;
  value?: string;
  name?: string;
  url?: string;
  alt?: string | null;
  children?: MdastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  /* unist's `Data` has no index signature, so this is the only shape that accepts it */
  data?: any;
}

export interface Construct {
  from: number;
  to: number;
  /** End of the opening markup: the content starts here. */
  openTo: number;
  /** Start of the closing markup: the content ends here. */
  closeFrom: number;
  /** `style` draws the content; `replace` swaps the whole construct for a widget. */
  kind: "style" | "replace";
  /** The dialect rule, for a directive. Markdown's own emphasis has none. */
  rule?: Rule;
  /** Class the live editor puts on the content run. */
  className?: string;
  /** A web address carried by a link label. */
  href?: string;
  /** An image's source and description. */
  image?: { src: string; alt: string };
}

export function readTree(text: string): MdastNode {
  return fromMarkdown(text, {
    extensions: [gfm(), directive()],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()],
  }) as unknown as MdastNode;
}

/**
 * Inline constructs of one block of text, in text coordinates.
 *
 * The editor calls this per paragraph, memoised by the text, so a keystroke
 * re-parses one paragraph and a scroll parses only what came into view.
 */
export function parseInline(text: string): readonly Construct[] {
  const cached = inlineCache.get(text);
  if (cached) return cached;
  const constructs = read(text);
  if (inlineCache.size >= 512) inlineCache.clear();
  inlineCache.set(text, constructs);
  return constructs;
}

const inlineCache = new Map<string, readonly Construct[]>();

function read(text: string): Construct[] {
  const constructs: Construct[] = [];
  for (const child of readTree(text).children ?? []) visit(child, constructs, text);
  constructs.sort((left, right) => left.from - right.from || left.to - right.to);
  return constructs;
}

function visit(node: MdastNode, out: Construct[], text: string) {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (typeof from !== "number" || typeof to !== "number" || to <= from) return;

  const children = node.children ?? [];
  const innerStart =
    children.length > 0 ? children[0].position?.start.offset ?? from : from;
  const innerEnd =
    children.length > 0
      ? children[children.length - 1].position?.end.offset ?? to
      : to;

  const style = (className: string, rule?: Rule, href?: string) => {
    out.push({ from, to, openTo: innerStart, closeFrom: innerEnd, kind: "style", className, rule, href });
    for (const child of children) visit(child, out, text);
  };

  switch (node.type) {
    case "emphasis":
      return style("cm-em");
    case "strong":
      return style("cm-strong");
    case "delete":
      return style("cm-strike");
    case "link":
      return style("cm-link", undefined, webAddress(node.url));
    case "linkReference":
      return style("cm-link");
    case "inlineCode": {
      let openTo = from;
      while (openTo < to && text[openTo] === "`") openTo += 1;
      let closeFrom = to;
      while (closeFrom > openTo && text[closeFrom - 1] === "`") closeFrom -= 1;
      out.push({ from, to, openTo, closeFrom, kind: "style", className: "cm-code" });
      return;
    }
    case "image":
      out.push({
        from,
        to,
        openTo: from,
        closeFrom: to,
        kind: "replace",
        image: { src: node.url ?? "", alt: node.alt ?? "" },
      });
      return;
    case "textDirective": {
      const rule = ruleFor(node.name, "inline");
      // An unknown name, an empty label or a block word in a sentence stays
      // exactly as typed: the source and the page must always agree.
      if (!rule || children.length === 0 || !text.slice(innerStart, innerEnd).trim()) return;
      return style(rule.className, rule);
    }
    case "html":
      // Raw HTML is not rendered and not hidden: it reads as the source did.
      return;
    default:
      for (const child of children) visit(child, out, text);
  }
}

function webAddress(destination: string | undefined): string | undefined {
  if (!destination) return undefined;
  try {
    const url = new URL(destination);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// ── Blocks ───────────────────────────────────────────────────────────────────

/** A callout as the document's own tree sees it. The live editor must agree. */
export interface DocumentBlock {
  name: string;
  rule: Rule;
  /** The whole block, fences included. */
  from: number;
  to: number;
  title: string;
}

/** Every registered `:::name` block in a document, in order. */
export function blockConstructs(markdown: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const collect = (node: MdastNode) => {
    if (node.type === "containerDirective") {
      const rule = ruleFor(node.name, "block");
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (rule && typeof from === "number" && typeof to === "number") {
        blocks.push({ name: node.name ?? "", rule, from, to, title: blockTitle(node, rule) });
      }
    }
    // A callout holds callouts: keep walking into whatever it holds.
    for (const child of node.children ?? []) collect(child);
  };
  collect(readTree(markdown));
  return blocks;
}

/** A block's heading: its label, or the rule's own word for a hand-written fence. */
export function blockTitle(node: MdastNode, rule: Rule): string {
  const head = (node.children ?? []).find(isDirectiveLabel);
  const label = head ? textOf(head) : "";
  return label.trim() || rule.defaultLabel || (node.name ?? "");
}

/** The label of a container arrives as a paragraph, marked as such. */
export function isDirectiveLabel(node: MdastNode): boolean {
  return node.data?.directiveLabel === true;
}

function textOf(node: MdastNode): string {
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(textOf).join("");
}

// ── Excerpts ─────────────────────────────────────────────────────────────────

/**
 * The first line of readable text, for a task row or a preview subtitle.
 * Deliberately a scan rather than a parse: a board draws hundreds of rows.
 */
export function firstLine(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = stripLine(raw);
    if (line) return line;
  }
  return "";
}

const DIRECTIVE_LABEL = /:([A-Za-z][\w-]*)\[([^\]\n]*)\]/g;

function stripLine(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // A fence line names no body: its label is the best line to show.
  if (trimmed.startsWith(":::")) {
    return (/^:{3,}[A-Za-z][\w-]*\[([^\]\n]*)\]/.exec(trimmed)?.[1] ?? "").trim();
  }
  let text = trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:>\s?)+/, "")
    .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\d+\.\s+/, "");
  text = text.replace(DIRECTIVE_LABEL, "$2");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\*\*|__|~~|[*_`]/g, "");
  return text.trim();
}
