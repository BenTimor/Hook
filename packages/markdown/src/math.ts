/**
 * LaTeX, in the dialect everyone already knows.
 *
 * The syntax is TeX's own — `$e^{i\pi}+1=0$` in a sentence, `$$...$$` for a
 * line of its own — because a person writing math in Markdown, and a model
 * writing it from training, both expect exactly that. Nothing new to learn.
 *
 * KaTeX parses it and emits **MathML**, which Chromium and WebKit draw with no
 * stylesheet and no fonts. That matters most in the browser, where the dock is
 * one `panel.mjs` and its stylesheet is inlined: KaTeX's HTML output would need
 * ~1.2 MB of woff2 inside that single file, MathML needs nothing. The trade is
 * KaTeX's last percent of typesetting polish for a bundle that does not grow.
 *
 * A formula that does not parse is shown as the TeX that was typed, in red:
 * a page must never lose text because its math is wrong.
 */

import katex from "katex";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

import type { MdastNode } from "./parse.ts";

/** The parser: `$…$` inline, `$$…$$` on its own line. */
export { remarkMath };

/**
 * The read view's half. `remark-rehype` hands KaTeX a `math` element and this
 * turns it into `<math>`; `errorColor` is a var so the wrong formula reads as
 * an error in every theme rather than as a colour from another palette.
 */
export const MATH_REHYPE = [
  [
    rehypeKatex,
    { output: "mathml", throwOnError: false, strict: "ignore", errorColor: "var(--danger)" },
  ],
] as const;

/** TeX punctuation: a formula has some, a sentence about a price has none. */
const TEX = /[\\^_{}=+*/|<>~]/;

/** Two letters in a row: something a person would call a word. */
const WORD = /\p{L}{2}/u;

/**
 * `$5 and the other costs $10.` is a sentence, not a formula.
 *
 * Remark-math's single-dollar rule is looser than the one people expect: it
 * only trims padding when *both* ends of the run are spaces, so a run that
 * starts on `5` and ends on a space becomes math. That is how every inline
 * `$…$` stays available, and it is also how a price turns into an equation.
 *
 * So: an inline run whose content has a space, a word and no TeX at all is left
 * exactly as it was typed. `$5 and $10` keeps its dollars; `$x = 5$`, `$\pi r^2$`
 * and `$x^2$` are untouched, because a formula is not a sentence.
 */
export function proseMath(value: string): boolean {
  return /\s/.test(value) && WORD.test(value) && !TEX.test(value);
}

/**
 * The rendered maths, for a surface that draws its own (the formatted editor's
 * widget). Null when KaTeX refuses the TeX: the caller then shows the source,
 * which is what the read view does too.
 */
export function renderMath(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(latexFractions(tex), {
      output: "mathml",
      displayMode: display,
      throwOnError: true,
      strict: "ignore",
    });
  } catch {
    return null;
  }
}


// ── `1/2` as a fraction ──────────────────────────────────────────────────────

/**
 * Commands whose argument is *words*, not maths. A slash inside them is part of
 * the text (`\text{km/h}`, `\href{https://x.dev/a/b}{…}`), so the argument is
 * copied through untouched.
 */
const TEXT_COMMANDS = new Set([
  "text",
  "textrm",
  "textbf",
  "textit",
  "textsf",
  "texttt",
  "mbox",
  "hbox",
  "href",
  "url",
  "verb",
  "operatorname",
]);

const ALNUM = /[A-Za-z0-9.]/;

/** Index of the `}` that closes the `{` at `open`, or -1. */
function closeBrace(tex: string, open: number): number {
  let depth = 0;
  for (let i = open; i < tex.length; i += 1) {
    const ch = tex[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `}` before `close`, matching it, or -1. */
function openBrace(tex: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    const ch = tex[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The operand that ends where `end` points: a group, or a run with a script. */
function leftOperand(tex: string, end: number): { start: number; text: string } | null {
  let i = end - 1;
  while (i >= 0 && tex[i] === " ") i -= 1;
  if (i < 0) return null;

  if (tex[i] === "}") {
    const open = openBrace(tex, i);
    if (open < 0) return null;
    const before = tex[open - 1];
    // A script hangs off a base: `x^{2}` is one operand.
    if (before === "^" || before === "_") {
      const base = leftOperand(tex, open - 1);
      return base ? { start: base.start, text: base.text + tex.slice(open - 1, i + 1) } : null;
    }
    // A group that is some command's argument is a command, not a plain group —
    // and so is the second of two groups, `\frac{a}{b}`.
    if (before === "}") return null;
    // `\frac{a}{b}`, `\sqrt{2}`: the group is a command's argument, not an
    // operand, so the slash next to it has nothing safe to take.
    let nameStart = open - 1;
    while (nameStart >= 0 && /[A-Za-z]/.test(tex[nameStart])) nameStart -= 1;
    if (nameStart < open - 1 && tex[nameStart] === "\\") return null;
    return { start: open, text: tex.slice(open + 1, i) };
  }

  if (tex[i] === ")") {
    let depth = 0;
    for (let j = i; j >= 0; j -= 1) {
      if (tex[j] === ")") depth += 1;
      else if (tex[j] === "(") {
        depth -= 1;
        if (depth === 0) return { start: j, text: tex.slice(j + 1, i) };
      }
    }
    return null;
  }

  if (ALNUM.test(tex[i])) {
    let start = i;
    while (start > 0 && ALNUM.test(tex[start - 1])) start -= 1;
    // `x^2` — the script belongs to the operand, and so does its base.
    if (tex[start - 1] === "^" || tex[start - 1] === "_") {
      const base = leftOperand(tex, start - 1);
      if (base) return { start: base.start, text: base.text + tex.slice(start - 1, i + 1) };
    }
    return { start, text: tex.slice(start, i + 1) };
  }

  return null;
}

/** The operand that starts at `at`: a group, or a run with a script. */
function rightOperand(tex: string, at: number): { end: number; text: string } | null {
  let i = at;
  while (i < tex.length && tex[i] === " ") i += 1;
  if (i >= tex.length) return null;

  if (tex[i] === "{") {
    const close = closeBrace(tex, i);
    return close < 0 ? null : { end: close + 1, text: tex.slice(i + 1, close) };
  }

  if (tex[i] === "(") {
    let depth = 0;
    for (let j = i; j < tex.length; j += 1) {
      if (tex[j] === "(") depth += 1;
      else if (tex[j] === ")") {
        depth -= 1;
        if (depth === 0) return { end: j + 1, text: tex.slice(i + 1, j) };
      }
    }
    return null;
  }

  if (!ALNUM.test(tex[i])) return null;
  let end = i;
  while (end < tex.length && ALNUM.test(tex[end])) end += 1;
  // A script on the right operand belongs to it: `a/x^2`.
  const script = tex[end];
  if (script === "^" || script === "_") {
    if (tex[end + 1] === "{") {
      const close = closeBrace(tex, end + 1);
      if (close > 0) return { end: close + 1, text: tex.slice(i, close + 1) };
    } else if (end + 1 < tex.length) {
      return { end: end + 2, text: tex.slice(i, end + 2) };
    }
  }
  return { end, text: tex.slice(i, end) };
}

/**
 * `1/2` becomes `\frac{1}{2}`: the one piece of TeX everybody writes the short
 * way. `\frac{1}{2}` keeps working — a run that already is a fraction has no
 * slash for this to find.
 *
 * Only operands this can read exactly are rewritten: a number or a word, one
 * with a script, a `(…)` group, or a `{…}` group that is not some command's
 * argument. A slash inside `\text{…}` or `\href{…}` is text and is left alone,
 * as is anything it cannot read (`\sqrt{2}/2`, `a/b/c` after the first pair),
 * because a formula that silently changes meaning is worse than a slash.
 */
export function latexFractions(tex: string): string {
  let out = "";
  let i = 0;
  while (i < tex.length) {
    const ch = tex[i];
    if (ch === "\\") {
      // Scanned by hand: a TeX command is a backslash and letters.
      let end = i + 1;
      while (end < tex.length && /[A-Za-z]/.test(tex[end])) end += 1;
      if (end === i + 1) {
        out += tex.slice(i, i + 2);
        i += 2;
        continue;
      }
      const name = tex.slice(i + 1, end);
      out += tex.slice(i, end);
      i = end;
      if (TEXT_COMMANDS.has(name)) {
        const args = name === "href" ? 2 : 1;
        for (let arg = 0; arg < args && tex[i] === "{"; arg += 1) {
          const close = closeBrace(tex, i);
          if (close < 0) break;
          out += tex.slice(i, close + 1);
          i = close + 1;
        }
      }
      continue;
    }
    if (ch === "/" && tex[i + 1] !== "/" && !out.endsWith(":/") && !out.endsWith("//")) {
      const left = leftOperand(out, out.length);
      const right = rightOperand(tex, i + 1);
      if (left && right) {
        out = `${out.slice(0, left.start)}\\frac{${left.text}}{${right.text}}`;
        i = right.end;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** `1/2` in a formula is a fraction; the string stays the author's. */
export function mathFractions() {
  return (tree: MdastNode) => {
    rewriteMath(tree);
  };
}

function rewriteMath(node: MdastNode) {
  for (const child of node.children ?? []) {
    if ((child.type === "inlineMath" || child.type === "math") && typeof child.value === "string") {
      const tex = latexFractions(child.value);
      child.value = tex;
      // `mdast-util-math` copies the TeX into a hast child when it parses, and
      // that copy is what `rehype-katex` renders — so it has to move too.
      setMathText(child, tex);
    }
    rewriteMath(child);
  }
}

/** Point a math node's rendered text at `tex`, wherever the extension put it. */
function setMathText(node: MdastNode, tex: string) {
  const data = (node.data ??= {});
  const children = data.hChildren;
  if (!Array.isArray(children) || children.length === 0) {
    data.hChildren = [{ type: "text", value: tex }];
    return;
  }
  const first = children[0];
  if (first && first.type === "element" && Array.isArray(first.children)) {
    first.children = [{ type: "text", value: tex }];
    return;
  }
  children.length = 0;
  children.push({ type: "text", value: tex });
}

export function mathProse() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    const source = typeof file?.value === "string" ? file.value : "";
    rewrite(tree, source);
  };
}

function rewrite(node: MdastNode, source: string) {
  const children = node.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child.type === "inlineMath") {
      const value = child.value ?? "";
      const prose = child.type === "inlineMath" && proseMath(value);
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (prose && typeof start === "number" && typeof end === "number") {
        children[index] = { type: "text", value: source.slice(start, end) };
        continue;
      }
    }
    rewrite(child, source);
  }
}
