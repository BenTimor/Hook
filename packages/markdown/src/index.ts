export { RULES, ruleFor, canonical, familyRule } from "./rules.ts";
export type { Rule, RuleScope } from "./rules.ts";

export { parseInline, blockConstructs, blockTitle, firstLine, readTree } from "./parse.ts";
export type { Construct, DocumentBlock, MdastNode } from "./parse.ts";

export { declaredDirection, readDocumentMeta } from "./meta.ts";
export type { DocumentMeta, TextDirection } from "./meta.ts";

/**
 * What Copy puts on the clipboard for a reply: the message, without the
 * direction markers that are structure rather than text.
 */
export { copyableMarkdown } from "./copy.ts";

export { documentImageSource } from "./images.ts";

export { DocumentMarkdown } from "./DocumentMarkdown.tsx";
export type { DocumentMarkdownProps } from "./DocumentMarkdown.tsx";

/**
 * The read view's plugins, for a surface that draws the dialect itself: a chat
 * reply goes through exactly these, so a callout in an answer is the callout a
 * document draws. `remarkDirective` is re-exported from here because this
 * package is the one place that owns the directive grammar; a surface should
 * never bring its own copy.
 */
export { documentBreaks, documentDirectives } from "./remark.ts";
export { default as remarkDirective } from "remark-directive";

/**
 * LaTeX: the syntax is TeX's own, and the output is MathML so no stylesheet or
 * font has to travel with it (`math.ts` for the why).
 */
export {
  MATH_REHYPE,
  latexFractions,
  mathFractions,
  mathProse,
  proseMath,
  remarkMath,
  renderMath,
} from "./math.ts";

export {
  applyRule,
  constructsBetween,
  decorationsFor,
  documentDirection,
  linkAt,
  livePreview,
  protectMeta,
  repairTransaction,
  setDocumentDirection,
  toggleDirection,
  wrapBlock,
} from "./live.ts";
export type { LiveDecorations, LiveOptions } from "./live.ts";
