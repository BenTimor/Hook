import {
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
  type Range,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type WidgetType,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

import { canonical, ruleFor, type Rule } from "./rules.ts";
import { parseInline, type Construct } from "./parse.ts";
import {
  isMetaLine,
  metaDirection,
  metaLine,
  type TextDirection,
} from "./meta.ts";

/**
 * The live editor's half of the dialect.
 *
 * Every inline construct — markdown's own emphasis, a link, an image, a
 * `:red[…]` run — arrives as three spans: the whole thing, the opening markup
 * and the closing markup. Decorations hide the markup and style the content;
 * the deletion repair uses the same spans, which is why a new rule gets both for
 * free and why removing formatted text can never leave half a tag behind.
 */

export interface LiveOptions {
  /** A widget for an embedded or linked image; without one the markdown shows. */
  image?: (image: { src: string; alt: string }) => WidgetType | null;
  /**
   * A widget for a formula. The maths is drawn while the caret is elsewhere and
   * the TeX shows while it is inside, so a formula can still be edited by hand
   * without a separate source mode.
   */
  math?: (math: { tex: string; display: boolean }) => WidgetType | null;
  /** A widget that gives a hand-written `:::note` (no label) its heading. */
  calloutTitle?: (rule: Rule) => WidgetType | null;
}

export interface LiveDecorations {
  all: DecorationSet;
  /** The hidden markup, as atomic ranges so a selection takes it along. */
  hidden: DecorationSet;
}

const hide = Decoration.replace({});

const HEADING = /^(#{1,6})\s+/;
const DIVIDER = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST = /^([-*+]\s+|\d+\.\s+)/;
const FENCE = /^ {0,3}:{3,}/;
const BLOCK_OPEN = /^( {0,3})(:{3,})([A-Za-z][\w-]*)(?:\[([^\]\n]*)\])?\s*$/;
const BLOCK_CLOSE = /^( {0,3})(:{3,})\s*$/;

type LineKind = "blank" | "divider" | "heading" | "list" | "fence" | "plain";

interface LineShape {
  /** Length of the leading `>` markers, so a quoted paragraph joins up. */
  quote: number;
  kind: LineKind;
  /** Where the inline content starts, within the line. */
  content: number;
  /** Heading level, when it is one. */
  level: number;
}

/** Strip the blockquote markers the way CommonMark does, up to three spaces in. */
function quotePrefix(text: string): number {
  let at = 0;
  for (;;) {
    let probe = at;
    let spaces = 0;
    while (probe < text.length && text[probe] === " " && spaces < 3) {
      probe += 1;
      spaces += 1;
    }
    if (text[probe] !== ">") return at;
    probe += 1;
    if (text[probe] === " ") probe += 1;
    at = probe;
  }
}

function shape(text: string): LineShape {
  const quote = quotePrefix(text);
  const inner = text.slice(quote);
  if (!inner.trim()) return { quote, kind: "blank", content: text.length, level: 0 };
  if (DIVIDER.test(inner)) return { quote, kind: "divider", content: quote, level: 0 };
  const heading = HEADING.exec(inner);
  if (heading) return { quote, kind: "heading", content: quote + heading[0].length, level: heading[1].length };
  if (FENCE.test(inner)) return { quote, kind: "fence", content: quote, level: 0 };
  const list = LIST.exec(inner);
  if (list) return { quote, kind: "list", content: quote + list[0].length, level: 0 };
  return { quote, kind: "plain", content: quote, level: 0 };
}

function continues(previous: string, next: string): boolean {
  const before = shape(previous);
  if (before.kind !== "plain") return false;
  const after = shape(next);
  return after.kind === "plain" && after.quote === before.quote;
}

// ── Inline blocks ────────────────────────────────────────────────────────────

/**
 * A run of lines the inline parser reads as one block: a paragraph, or a
 * heading, list item or fenced line on its own. `segments` maps parsed offsets
 * back to the document, so a construct may cross a line break.
 */
interface Unit {
  first: number;
  last: number;
  text: string;
  segments: { textFrom: number; docFrom: number; length: number }[];
}

function readUnit(doc: Text, start: number): Unit {
  const line = doc.line(start);
  const head = shape(line.text);
  const segments: Unit["segments"] = [];
  let text = "";
  let number = start;

  const append = (source: string, content: number, from: number) => {
    const part = source.slice(content);
    if (segments.length > 0) text += "\n";
    segments.push({ textFrom: text.length, docFrom: from + content, length: part.length });
    text += part;
  };

  append(line.text, head.content, line.from);
  if (head.kind !== "plain") return { first: start, last: number, text, segments };

  while (number < doc.lines && continues(doc.line(number).text, doc.line(number + 1).text)) {
    number += 1;
    const next = doc.line(number);
    append(next.text, shape(next.text).content, next.from);
  }
  return { first: start, last: number, text, segments };
}

function toDoc(unit: Unit, offset: number): number {
  for (const segment of unit.segments) {
    if (offset <= segment.textFrom + segment.length) return segment.docFrom + offset - segment.textFrom;
  }
  const last = unit.segments[unit.segments.length - 1];
  return last.docFrom + last.length;
}

/** Constructs that touch a document range, in document coordinates. */
export function constructsBetween(state: EditorState, from: number, to: number): Construct[] {
  const doc = state.doc;
  const start = Math.min(Math.max(from, 0), doc.length);
  const end = Math.min(Math.max(to, start), doc.length);
  const firstLine = doc.lineAt(start).number;
  const lastLine = doc.lineAt(end).number;
  const found: Construct[] = [];

  let number = firstLine;
  while (number <= lastLine) {
    const unit = readUnit(doc, number);
    for (const construct of parseInline(unit.text)) {
      const mapped: Construct = {
        ...construct,
        from: toDoc(unit, construct.from),
        to: toDoc(unit, construct.to),
        openTo: toDoc(unit, construct.openTo),
        closeFrom: toDoc(unit, construct.closeFrom),
      };
      const touches =
        start === end
          ? mapped.from < start && start < mapped.to
          : mapped.from < end && start < mapped.to;
      if (touches) found.push(mapped);
    }
    number = unit.last + 1;
  }
  return found;
}

/**
 * Whether the caret is in a run or one character beside it: close enough that
 * the run is what is being written. A formula is drawn while this is false and
 * shown as its own TeX while it is true, and the deletion repair follows the
 * same answer — a formula you can read as source is text you edit, not a unit
 * that vanishes whole.
 */
function touchesRange(
  from: number,
  to: number,
  selection: { from: number; to: number },
): boolean {
  return selection.from <= to + 1 && selection.to >= from - 1;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

interface BlockSpan {
  rule: Rule;
  /** How many colons open it; a closer needs at least as many. */
  fence: number;
  openLine: number;
  openFrom: number;
  /** Start and end of the rule's word, `:::note` without the colons. */
  nameFrom: number;
  nameTo: number;
  /** Start of the label, or the end of the name when there is none. */
  labelFrom: number;
  labelTo: number;
  /** Where the label's `]` sits, or `labelTo` when there are no brackets. */
  labelEnd: number;
  closeLine: number;
  closeFrom: number;
  closeTo: number;
}

const blockCache = new WeakMap<Text, BlockSpan[]>();

/**
 * Every `:::name` block, innermost closers applied first. This scan deliberately
 * does not know about fenced code: `micromark` closes a container at a line of
 * colons whatever surrounds it, and the editor has to draw what the page shows.
 */
function blockSpans(doc: Text): BlockSpan[] {
  const cached = blockCache.get(doc);
  if (cached) return cached;
  const spans: BlockSpan[] = [];
  const open: BlockSpan[] = [];

  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const colon = line.text.search(/\S/);
    if (colon < 0 || line.text[colon] !== ":") continue;

    const opener = BLOCK_OPEN.exec(line.text);
    if (opener) {
      const rule = ruleFor(opener[3], "block");
      if (!rule) continue;
      const indent = opener[1].length;
      const nameFrom = indent + opener[2].length;
      const nameEnd = nameFrom + opener[3].length;
      const label = opener[4];
      const span: BlockSpan = {
        rule,
        fence: opener[2].length,
        openLine: number,
        openFrom: line.from + indent,
        nameFrom: line.from + nameFrom,
        nameTo: line.from + nameEnd,
        labelFrom: line.from + (label === undefined ? nameEnd : nameEnd + 1),
        labelTo: line.from + (label === undefined ? nameEnd : nameEnd + 1 + label.length),
        labelEnd: line.from + (label === undefined ? nameEnd : nameEnd + 2 + label.length),
        closeLine: 0,
        closeFrom: 0,
        closeTo: 0,
      };
      spans.push(span);
      open.push(span);
      continue;
    }

    const closer = BLOCK_CLOSE.exec(line.text);
    if (!closer) continue;
    while (open.length > 0 && open[open.length - 1].fence <= closer[2].length) {
      const span = open.pop() as BlockSpan;
      span.closeLine = number;
      span.closeFrom = line.from + closer[1].length;
      span.closeTo = line.to;
    }
  }

  blockCache.set(doc, spans);
  return spans;
}

/** The innermost block covering a line, fences included. */
function spanAt(spans: readonly BlockSpan[], number: number): BlockSpan | null {
  let found: BlockSpan | null = null;
  for (const span of spans) {
    const end = span.closeLine === 0 ? Number.MAX_SAFE_INTEGER : span.closeLine;
    if (number >= span.openLine && number <= end) found = span;
  }
  return found;
}

// ── Decorations ──────────────────────────────────────────────────────────────

function isCode(state: EditorState, position: number): boolean {
  let node = syntaxTree(state).resolveInner(position, 1);
  while (node.parent && node.name !== "FencedCode" && node.name !== "CodeBlock") node = node.parent;
  return node.name === "FencedCode" || node.name === "CodeBlock";
}

export function decorationsFor(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  options: LiveOptions = {},
): LiveDecorations {
  const doc = state.doc;
  const items: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const lineClasses = new Map<number, string[]>();
  const lineDirections = new Map<number, string>();

  const add = (from: number, to: number, decoration: Decoration, replace = false) => {
    if (from < 0 || to > doc.length || from > to) return;
    if (from === to && replace) return;
    const range = decoration.range(from, to);
    items.push(range);
    if (replace) hidden.push(range);
  };
  const mark = (position: number, ...classes: (string | false | undefined)[]) => {
    const list = lineClasses.get(position) ?? [];
    for (const name of classes) if (name) list.push(name);
    lineClasses.set(position, list);
  };

  /**
   * The body of a block. A callout draws a box, a direction wrapper is not one:
   * its lines simply read in the direction it names, through the line's own
   * `dir` attribute. That is the passage's direction; the page's is the
   * document's. Code is left alone (a sample stays left to right).
   */
  const markBody = (position: number, span: BlockSpan, number: number) => {
    if (span.rule.dir) {
      mark(position, "cm-dir-body");
      lineDirections.set(position, span.rule.dir);
      return;
    }
    const end = span.closeLine === 0 ? doc.lines : span.closeLine - 1;
    mark(
      position,
      "cm-callout-body",
      number === span.openLine + 1 && "cm-callout-body-first",
      number === end && "cm-callout-body-last",
    );
  };

  const emit = (constructs: readonly Construct[], map: (offset: number) => number) => {
    for (const construct of constructs) {
      const from = map(construct.from);
      const to = map(construct.to);
      if (construct.kind === "replace") {
        if (construct.math) {
          // A formula is drawn until the caret comes near it, and then it is the
          // TeX again: writing `$x^2$` means editing the source, and a rendered
          // formula you cannot get inside is one you cannot fix. "Near" is the
          // run itself plus one character on each side, so the caret touching an
          // edge is already enough.
          const touching = touchesRange(from, to, state.selection.main);
          const widget = !touching && options.math ? options.math(construct.math) : null;
          // Deliberately not in `hidden`: hidden ranges are atomic, and an
          // atomic formula would be one the caret can only jump over.
          if (widget) add(from, to, Decoration.replace({ widget }));
          else add(from, to, Decoration.mark({ class: "cm-math-source" }));
          continue;
        }
        const widget = construct.image && options.image ? options.image(construct.image) : null;
        if (widget) add(from, to, Decoration.replace({ widget }), true);
        continue;
      }
      const openTo = map(construct.openTo);
      const closeFrom = map(construct.closeFrom);
      add(from, openTo, hide, true);
      add(closeFrom, to, hide, true);
      if (openTo < closeFrom) {
        const attributes = construct.href ? { "data-link-url": construct.href } : undefined;
        add(openTo, closeFrom, Decoration.mark({ class: construct.className ?? "cm-em", attributes }));
      }
    }
  };

  const spans = blockSpans(doc);

  for (const visible of ranges) {
    let number = doc.lineAt(Math.min(visible.from, doc.length)).number;
    const lastLine = doc.lineAt(Math.min(visible.to, doc.length)).number;
    // A paragraph that started above the viewport must still parse as one block.
    while (number > 1 && continues(doc.line(number - 1).text, doc.line(number).text)) number -= 1;

    while (number <= lastLine) {
      const line = doc.line(number);
      const info = shape(line.text);
      const span = spanAt(spans, number);
      if (span?.rule.dir) lineDirections.set(line.from, span.rule.dir);

      // The metadata line is the document's setting, not its text: it is never
      // shown, and the caret never stops on it (see `settle`).
      if (number === 1 && isMetaLine(line.text)) {
        mark(line.from, "cm-meta");
        add(line.from, line.to, hide, true);
        number += 1;
        continue;
      }

      if (isCode(state, line.from)) {
        mark(line.from, "cm-code-block-line");
        number += 1;
        continue;
      }

      if (span && span.openLine === number) {
        if (span.rule.dir) {
          // A direction wrapper reads as a quiet word, not as a box: the
          // passage below it flips, and that is what says what it does.
          mark(line.from, "cm-dir-head");
          add(span.openFrom, span.nameFrom, hide, true);
          add(span.nameTo, span.labelEnd, hide, true);
          add(span.nameFrom, span.nameTo, Decoration.mark({ class: "cm-dir-label" }));
        } else {
          mark(line.from, "cm-callout-head");
          const empty = span.labelTo === span.labelFrom;
          const widget = empty && options.calloutTitle ? options.calloutTitle(span.rule) : null;
          if (widget) {
            add(span.openFrom, span.labelEnd, Decoration.replace({ widget }), true);
          } else {
            add(span.openFrom, span.labelFrom, hide, true);
            add(span.labelTo, span.labelEnd, hide, true);
            if (!empty) {
              add(span.labelFrom, span.labelTo, Decoration.mark({ class: "cm-callout-title" }));
              emit(parseInline(doc.sliceString(span.labelFrom, span.labelTo)), (offset) => span.labelFrom + offset);
            }
          }
        }
        number += 1;
        continue;
      }

      if (span && span.closeLine === number) {
        mark(line.from, span.rule.dir ? "cm-dir-close" : "cm-callout-close");
        add(span.closeFrom, span.closeTo, hide, true);
        number += 1;
        continue;
      }

      if (info.kind === "divider") {
        mark(line.from, "cm-rule");
        add(line.from, line.to, hide, true);
        number += 1;
        continue;
      }

      if (info.kind === "heading") {
        mark(line.from, `cm-h${info.level}`);
        if (info.quote > 0) mark(line.from, "cm-quote");
        add(line.from, line.from + info.content, hide, true);
        const unit = readUnit(doc, number);
        emit(parseInline(unit.text), (offset) => toDoc(unit, offset));
        number = unit.last + 1;
        continue;
      }

      if (info.kind === "fence") {
        // A line of colons that could not close its callout is body text; it
        // needs the body's edge, not a bare line.
        if (span) markBody(line.from, span, number);
        number += 1;
        continue;
      }

      if (info.kind === "blank") {
        if (span) markBody(line.from, span, number);
        number += 1;
        continue;
      }

      // A plain line or a list item: one inline block, possibly over many lines.
      const unit = readUnit(doc, number);
      if (info.quote > 0) {
        for (let inner = unit.first; inner <= unit.last; inner += 1) mark(doc.line(inner).from, "cm-quote");
      }
      add(line.from, line.from + info.quote, hide, true);
      if (span) {
        for (let inner = unit.first; inner <= unit.last; inner += 1) {
          const at = doc.line(inner).from;
          markBody(at, span, inner);
          if (span.rule.dir) lineDirections.set(at, span.rule.dir);
        }
      }
      emit(parseInline(unit.text), (offset) => toDoc(unit, offset));
      number = unit.last + 1;
    }
  }

  for (const [position, classes] of lineClasses) {
    const dir = lineDirections.get(position);
    add(
      position,
      position,
      Decoration.line({ class: classes.join(" "), attributes: dir ? { dir } : undefined }),
    );
  }

  return { all: Decoration.set(items, true), hidden: Decoration.set(hidden, true) };
}

/** The live preview as an extension: decorations and the deletion repair. */
export function livePreview(options: LiveOptions = {}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      all: DecorationSet;
      hidden: DecorationSet;
      constructor(view: EditorView) {
        const next = decorationsFor(view.state, view.visibleRanges, options);
        this.all = next.all;
        this.hidden = next.hidden;
      }
      update(update: ViewUpdate) {
        // A selection change matters: it is what turns a drawn formula back into
        // its TeX when the caret arrives.
        if (!update.docChanged && !update.viewportChanged && !update.selectionSet) return;
        const next = decorationsFor(update.view.state, update.view.visibleRanges, options);
        this.all = next.all;
        this.hidden = next.hidden;
      }
    },
    {
      decorations: (value) => value.all,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.hidden ?? Decoration.none),
    },
  );
  return [
    plugin,
    // Filters run last-added first: the metadata line is settled before the
    // repair measures anything, so no repair is ever computed against a change
    // that moved.
    EditorState.transactionFilter.of((transaction) => settleSelection(transaction)),
    EditorState.transactionFilter.of((transaction) => repairTransaction(transaction)),
    EditorState.transactionFilter.of((transaction) => protectMeta(transaction)),
  ];
}

// ── Deletion repair ──────────────────────────────────────────────────────────

interface Removed {
  from: number;
  to: number;
}

/**
 * Removing formatted text removes its markup with it.
 *
 * Three rules, the same for every construct and every future rule: delete the
 * whole content and the whole construct goes; delete into the opening or the
 * closing markup and the leftover markup goes too, leaving the text unwrapped;
 * delete inside the content and only the character goes. The result is always
 * valid Markdown, so the formatted editor never reveals half a tag.
 */
export function repairTransaction(transaction: Transaction): Transaction | readonly TransactionSpec[] {
  if (!transaction.docChanged) return transaction;
  if (!transaction.isUserEvent("delete") && !transaction.isUserEvent("input")) return transaction;

  const doc = transaction.startState.doc;
  const next = transaction.state.doc;
  const edits: { from: number; to: number; inserted: number }[] = [];
  let deletions = true;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    // A plain insertion cannot reach hidden markup: it happens between characters.
    if (fromA === toA) return;
    edits.push({ from: fromA, to: toA, inserted: toB - fromB });
    if (fromB !== toB) deletions = false;
  });
  if (edits.length === 0) return transaction;

  const removed: Removed[] = edits
    .filter((edit) => edit.inserted === 0)
    .map((edit) => ({ from: edit.from, to: edit.to }));
  const caret = transaction.startState.selection.main.head;
  const firstLine = doc.lineAt(Math.min(...edits.map((edit) => edit.from)));
  const lastLine = doc.lineAt(Math.min(Math.max(...edits.map((edit) => edit.to)), doc.length));
  const constructs = constructsBetween(transaction.startState, firstLine.from, lastLine.to);

  /** Changes in the document the user's edit produced. */
  const after: { from: number; to: number; insert?: string }[] = [];
  /** Changes in the document the user edited. */
  const before: Removed[] = [];
  const gone: Removed[] = [];

  // Inline markup is invisible, so an edit never changes it: an edit only ever
  // changes the text the markup wraps, and the markers are put back around
  // whatever survived. That is why deleting next to a formatted run removes a
  // character instead of the formatting.
  if (deletions) {
    const inline = constructs
      .filter((construct) => construct.kind === "style")
      .sort((left, right) => right.to - right.from - (left.to - left.from));

    for (const construct of inline) {
      if (gone.some((span) => construct.from >= span.from && construct.to <= span.to)) continue;

      // The whole content went: the run goes too, with both markers.
      if (removed.some((range) => range.from <= construct.openTo && range.to >= construct.closeFrom)) {
        gone.push(construct);
        continue;
      }

      const open = { from: construct.from, to: construct.openTo };
      const close = { from: construct.closeFrom, to: construct.to };
      const touched = removed.filter((range) => overlaps(range, open) || overlaps(range, close));
      if (touched.length === 0) continue;

      const start = transaction.changes.mapPos(construct.openTo, 1);
      const end = transaction.changes.mapPos(construct.closeFrom, -1);
      if (start >= end) {
        gone.push(construct);
        continue;
      }

      const openText = doc.sliceString(construct.from, construct.openTo);
      const closeText = doc.sliceString(construct.closeFrom, construct.to);
      const openAt = transaction.changes.mapPos(construct.from, -1);
      const closeAt = transaction.changes.mapPos(construct.to, 1);
      if (next.sliceString(openAt, start) !== openText) after.push({ from: openAt, to: start, insert: openText });
      if (next.sliceString(end, closeAt) !== closeText) after.push({ from: end, to: closeAt, insert: closeText });

      // A Backspace or Delete that removed nothing but markup removes the
      // character it was aimed at instead, so the key always does something.
      if (!touched.every((range) => range.to - range.from === 1)) continue;
      const backward = caret >= Math.max(...touched.map((range) => range.to));
      const target = visibleCharacter(construct, touched, backward, doc);
      if (target) before.push(target);
    }
  }

  // Block constructs and pictures are units: deleting at their edge removes them.
  for (const span of gone) before.push({ from: span.from, to: span.to });

  // A picture is a unit, and alone on its line it *is* the line: deleting it, or
  // the line break beside it, removes the line rather than leaving an empty one.
  for (const construct of constructs) {
    if (construct.kind !== "replace" || (!construct.image && !construct.math)) continue;
    // A formula whose TeX is on screen is being written: the keystroke is about
    // one character, and treating the run as a unit would delete the formula the
    // person is looking at.
    if (construct.math && touchesRange(construct.from, construct.to, transaction.startState.selection.main))
      continue;
    const line = doc.lineAt(construct.from);
    const alone =
      !doc.sliceString(line.from, construct.from).trim() && !doc.sliceString(construct.to, line.to).trim();
    const touched = removed.some((range) => range.from < construct.to && range.to > construct.from);
    if (!alone) {
      if (touched) before.push({ from: construct.from, to: construct.to });
      continue;
    }
    const lineBefore = line.number > 1 && removed.some((range) => range.from <= line.from - 1 && range.to >= line.from);
    const lineAfter = line.number < doc.lines && removed.some((range) => range.from <= line.to && range.to >= line.to + 1);
    if (touched || lineBefore || lineAfter) before.push({ from: line.from, to: Math.min(line.to + 1, doc.length) });
  }

  for (const span of blockSpans(doc)) {
    const openLine = doc.line(span.openLine);
    const closeStart = span.closeLine === 0 ? doc.length : doc.line(span.closeLine).from;
    const closeEnd = span.closeLine === 0 ? doc.length : doc.line(span.closeLine).to;
    const inside = removed.filter((range) => range.from < closeEnd && range.to > span.openFrom);
    if (inside.length === 0) continue;

    const bodyHit = inside.some((range) => range.from < closeStart && range.to > openLine.to);
    const left = without(doc.sliceString(openLine.to, closeStart), openLine.to, removed);
    if (bodyHit && !left.trim()) {
      before.push({ from: span.openFrom, to: Math.min(closeEnd + 1, doc.length) });
      continue;
    }

    const fenceTouched =
      inside.some((range) => range.from < openLine.to && range.to > openLine.from) ||
      (span.closeLine !== 0 && inside.some((range) => range.from < closeEnd && range.to > closeStart)) ||
      inside.some((range) => range.from <= openLine.to && range.to > openLine.to) ||
      (span.closeLine !== 0 && inside.some((range) => range.from < closeStart && range.to >= closeStart));
    if (!fenceTouched) continue;
    // Unwrap: the fences go, whatever the user did not delete stays.
    before.push({ from: span.openFrom, to: span.labelFrom });
    before.push({ from: span.labelTo, to: span.labelEnd });
    if (span.closeLine !== 0) {
      before.push({ from: Math.max(openLine.to, closeStart - 1), to: Math.min(closeEnd + 1, doc.length) });
    }
  }

  const changes: { from: number; to: number; insert?: string }[] = [...after];
  for (const range of before) {
    const from = transaction.changes.mapPos(range.from, -1);
    const to = transaction.changes.mapPos(range.to, 1);
    if (to > from) changes.push({ from, to });
  }
  if (changes.length === 0) return transaction;

  changes.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: typeof changes = [];
  for (const change of changes) {
    const last = merged[merged.length - 1];
    if (change.from === change.to && !change.insert) continue;
    if (last && change.from < last.to) {
      // Two repairs for the same text: keep the one that covers the other.
      if (change.to > last.to) merged[merged.length - 1] = change;
      continue;
    }
    merged.push(change);
  }
  if (merged.length === 0) return transaction;
  return [transaction, { changes: merged, sequential: true }];
}

function overlaps(range: Removed, span: Removed): boolean {
  return range.from < span.to && range.to > span.from;
}

/** The character a marker-only delete should have removed instead. */
function visibleCharacter(
  construct: Construct,
  touched: readonly Removed[],
  backward: boolean,
  doc: Text,
): Removed | null {
  const closing = touched.some((range) => range.from >= construct.closeFrom);
  const before = (position: number) => (position > 0 ? { from: position - 1, to: position } : null);
  const after = (position: number) =>
    position < doc.length ? { from: position, to: Math.min(position + 1, doc.length) } : null;
  if (backward) return closing ? before(construct.closeFrom) ?? before(construct.from) : before(construct.from);
  return closing ? after(construct.to) : after(construct.openTo) ?? after(construct.to);
}

/**
 * A caret never rests on a marker, and every arrow press moves.
 *
 * A marker is zero-width once it is hidden, so the buffer has two positions at
 * one place on screen — just before `:green[` and just after it, just before `]`
 * and just after it. Stopping on both makes an arrow key look like it did
 * nothing at the edge of a run. The caret stops at the *content* edge instead:
 * leaving the run crosses one visible character, and typing there stays in the
 * run, the way it does in a word processor.
 */
interface Edge {
  /** The caret's stop: the content edge, at the same place on screen. */
  stop: number;
  kind: "open" | "close";
}

function edgeAt(state: EditorState, position: number): Edge | null {
  const doc = state.doc;
  const constructs = constructsBetween(state, Math.max(0, position - 1), Math.min(position + 1, doc.length));
  for (const construct of constructs) {
    if (construct.kind !== "style" || construct.openTo >= construct.closeFrom) continue;
    // The hidden marker, and any position inside it, belong to the ghost side.
    if (position >= construct.from && position < construct.openTo) {
      return { stop: construct.openTo, kind: "open" };
    }
    if (position > construct.closeFrom && position <= construct.to) {
      return { stop: construct.closeFrom, kind: "close" };
    }
  }
  return null;
}

export function settle(state: EditorState, previous: number, next: number): number {
  let position = next;
  // The metadata line has no stops at all: anywhere on or before it is the same
  // place on screen, and it is the document's first real line that a person is
  // aiming at.
  const meta = metaEnd(state.doc);
  if (meta !== null) position = Math.max(position, Math.min(meta + 1, state.doc.length));
  for (let guard = 0; guard < 12; guard += 1) {
    const edge = edgeAt(state, position);
    if (!edge) return position;
    if (previous === edge.stop) {
      // The press crossed nothing but the marker: cross one character as well.
      position += edge.kind === "open" ? -1 : 1;
      if (position < 0 || position > state.doc.length) return edge.stop;
      continue;
    }
    position = edge.stop;
  }
  return position;
}

/**
 * Only a selection change settles: an edit keeps the selection it asked for, so
 * a toolbar action still selects the text it wrapped, and typing at the end of a
 * run keeps the caret in the run instead of stepping out of it.
 */
export function settleSelection(transaction: Transaction): Transaction | TransactionSpec {
  if (transaction.docChanged) return transaction;
  const selection = transaction.newSelection;
  if (selection.ranges.length !== 1) return transaction;
  const range = selection.main;
  if (!range.empty) return transaction;
  const before = transaction.startState.selection.main;
  const head = settle(transaction.startState, before.empty ? before.head : -1, range.head);
  if (head === range.head) return transaction;
  return { selection: EditorSelection.single(head) };
}

function without(text: string, offset: number, removed: readonly Removed[]): string {
  let result = "";
  let cursor = 0;
  for (const range of removed) {
    const from = Math.max(0, Math.min(text.length, range.from - offset));
    const to = Math.max(0, Math.min(text.length, range.to - offset));
    if (to <= cursor) continue;
    result += text.slice(cursor, from);
    cursor = Math.max(cursor, to);
  }
  return result + text.slice(cursor);
}

// ── The metadata line ────────────────────────────────────────────────────────

/** The end of the metadata line at the top of the document, or null. */
function metaEnd(doc: Text): number | null {
  const first = doc.line(1);
  return isMetaLine(first.text) ? first.to : null;
}

/** The direction the document itself asks for, from its top line. */
export function documentDirection(state: EditorState): TextDirection {
  return metaDirection(state.doc.line(1).text) ?? "ltr";
}

/**
 * Change the document's default direction: the metadata line goes in at the
 * top, or comes out on the way back to left to right.
 *
 * The transaction is its own user event, because the protection below has to
 * tell this deliberate write from a person typing at the start of the document.
 */
export function setDocumentDirection(state: EditorState, direction: TextDirection): TransactionSpec {
  const doc = state.doc;
  const first = doc.line(1);
  const current = metaDirection(first.text);
  if (direction === "rtl") {
    if (current !== null) {
      return {
        changes: { from: first.from, to: first.to, insert: metaLine("rtl") },
        userEvent: "hook.direction",
      };
    }
    // Always with a line break after it: the line is invisible, so the caret
    // and the first typed word belong on the line under it.
    const insert = `${metaLine("rtl")}\n`;
    return {
      changes: { from: 0, insert },
      selection: EditorSelection.cursor(state.selection.main.head + insert.length),
      scrollIntoView: true,
      userEvent: "hook.direction",
    };
  }
  if (current === null) return { changes: [] };
  const to = doc.length > first.to ? first.to + 1 : first.to;
  const removed = to - first.from;
  return {
    changes: { from: first.from, to },
    selection: EditorSelection.cursor(Math.max(0, state.selection.main.head - removed)),
    userEvent: "hook.direction",
  };
}

/**
 * The metadata line is invisible, so an ordinary edit can never change it.
 *
 * Typing at the very start of the document happens on the line under the
 * metadata line, so the line stays first and is never duplicated; a delete that
 * reaches it stops at its edge, and one that never leaves it does nothing. The
 * key always does something visible, the way a backspace on an invisible inline
 * marker removes the neighbouring character instead.
 */
export function protectMeta(transaction: Transaction): Transaction | readonly TransactionSpec[] {
  if (!transaction.docChanged) return transaction;
  // Only a person's own typing and deleting is steered away from the line:
  // undo, a document load and the toolbar's write all mean what they say.
  if (!transaction.isUserEvent("input") && !transaction.isUserEvent("delete")) return transaction;
  const doc = transaction.startState.doc;
  const end = metaEnd(doc);
  if (end === null) return transaction;
  const hasNext = doc.length > end;
  const after = hasNext ? end + 1 : end;
  const specs: { from: number; to?: number; insert?: string }[] = [];
  let touched = false;
  let caret: number | null = null;

  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let text = inserted.toString();
    if (fromA === toA) {
      if (fromA > end) {
        specs.push({ from: fromA, insert: text });
        return;
      }
      // Typing on the invisible line lands under it, and the line stays first.
      const write = hasNext ? text : `\n${text}`;
      specs.push({ from: after, insert: write });
      caret = after + write.length;
      touched = true;
      return;
    }
    // A replacement that started at the top carried the line with it: the copy
    // it brought back would be the duplicate the line must never have.
    if (hasNext && fromA < after) {
      const breakAt = text.search(/[\r\n]/);
      const head = breakAt === -1 ? text : text.slice(0, breakAt);
      text = isMetaLine(head) ? (breakAt === -1 ? "" : text.slice(breakAt + 1)) : text;
    }
    const from = Math.max(fromA, after);
    const to = Math.max(toA, after);
    if (from !== fromA || to !== toA) touched = true;
    if (to > from || text) specs.push({ from, to, insert: text });
  });
  if (!touched) return transaction;
  if (specs.length === 0) return [{ changes: [] }];

  const changes = transaction.startState.changes(specs);
  const firstReal = Math.min(end + 1, changes.newLength);
  const mapped = transaction.selection
    ? EditorSelection.create(
        transaction.selection.ranges.map((range) => {
          const anchor = Math.max(firstReal, changes.mapPos(range.anchor, 1));
          const head = Math.max(firstReal, changes.mapPos(range.head, -1));
          return EditorSelection.range(anchor, head);
        }),
      )
    : undefined;
  // The user event is an annotation, and the filters that run after this one
  // read it: a person typing must still look like a person typing.
  const event = transaction.annotation(Transaction.userEvent);
  return [
    {
      changes: specs,
      selection: caret !== null ? EditorSelection.cursor(caret) : mapped,
      annotations: event ? [Transaction.userEvent.of(event)] : undefined,
      scrollIntoView: transaction.scrollIntoView,
      effects: transaction.effects,
    },
  ];
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

/**
 * Wrap the selection in a rule, or remove the rules of its family.
 *
 * The edit is one replacement of the affected region, so a single undo puts the
 * document back, and applying a colour to a coloured run replaces the run
 * instead of nesting a second one.
 */
export function applyRule(state: EditorState, rule: Rule | null, family: string): TransactionSpec | null {
  const selection = state.selection.main;
  const doc = state.doc;
  const targets = constructsBetween(state, selection.from, selection.to).filter(
    (construct) => construct.rule?.family === family,
  );
  if (!rule && targets.length === 0) return null;

  const cuts: Removed[] = [];
  for (const target of targets) {
    cuts.push({ from: target.from, to: target.openTo });
    cuts.push({ from: target.closeFrom, to: target.to });
  }
  cuts.sort((left, right) => left.from - right.from);

  const regionFrom = Math.min(selection.from, cuts.length > 0 ? cuts[0].from : selection.from);
  const regionTo = Math.max(selection.to, cuts.length > 0 ? cuts[cuts.length - 1].to : selection.to);

  // The kept pieces of the region, so the selection maps into the new text.
  const keep: Removed[] = [];
  let cursor = regionFrom;
  for (const cut of cuts) {
    if (cut.to <= cursor) continue;
    if (cut.from > cursor) keep.push({ from: cursor, to: cut.from });
    cursor = Math.max(cursor, cut.to);
  }
  if (cursor < regionTo) keep.push({ from: cursor, to: regionTo });

  const offsetIn = (offset: number) => {
    let length = 0;
    for (const piece of keep) {
      if (offset <= piece.to) return length + Math.max(0, offset - piece.from);
      length += piece.to - piece.from;
    }
    return length;
  };

  let text = "";
  for (const piece of keep) text += doc.sliceString(piece.from, piece.to);
  let start = offsetIn(selection.from);
  let end = offsetIn(selection.to);
  if (start > end) [start, end] = [end, start];

  if (rule) {
    const open = `:${canonical(rule)}[`;
    text = text.slice(0, start) + open + text.slice(start, end) + "]" + text.slice(end);
    start += open.length;
    end += open.length;
  }

  return {
    changes: { from: regionFrom, to: regionTo, insert: text },
    selection: EditorSelection.range(regionFrom + start, regionFrom + end),
    scrollIntoView: true,
    userEvent: "input",
  };
}

/**
 * Fence the selected whole lines in a block rule: a callout, or a direction
 * wrapper. An empty body still gets a fence to type in, and the caret goes
 * where the next keystroke belongs — the title of a callout, the body of a
 * direction wrapper.
 */
export function wrapBlock(state: EditorState, rule: Rule): TransactionSpec {
  const selection = state.selection.main;
  const doc = state.doc;
  // The document's own metadata line is never part of what a fence wraps: it
  // is not text a reader sees, so a select-all must not move it into the body.
  const line = doc.lineAt(selection.from);
  const firstLine = line.number === 1 && doc.lines > 1 && isMetaLine(line.text) ? 2 : line.number;
  const from = doc.line(firstLine).from;
  const to = doc.lineAt(selection.to).to;
  const body = doc.sliceString(from, to);
  const name = canonical(rule);
  const title = rule.defaultLabel ?? "Note";
  const head = rule.dir ? `:::${name}` : `:::${name}[${title}]`;
  const text = body.trim() ? `${head}\n${body}\n:::` : `${head}\n\n:::`;
  // A direction wrapper keeps the lines it wrapped selected, so the passage it
  // flipped is the passage the next action sees; a callout selects its title.
  const start = from + head.length + 1;
  const titleFrom = from + 3 + name.length + 1;
  const selectionAfter = rule.dir
    ? { anchor: start, head: start + body.length }
    : { anchor: titleFrom, head: titleFrom + title.length };
  return {
    changes: { from, to, insert: text },
    selection: selectionAfter,
    scrollIntoView: true,
    userEvent: "input",
  };
}

/** The innermost `:::rtl`/`:::ltr` the selection is inside, fences included. */
function directionSpan(state: EditorState): BlockSpan | null {
  const selection = state.selection.main;
  const firstLine = state.doc.lineAt(selection.from).number;
  const lastLine = state.doc.lineAt(selection.to).number;
  let found: BlockSpan | null = null;
  for (const span of blockSpans(state.doc)) {
    if (!span.rule.dir) continue;
    const end = span.closeLine === 0 ? Number.MAX_SAFE_INTEGER : span.closeLine;
    if (firstLine >= span.openLine && lastLine <= end) found = span;
  }
  return found;
}

/** Take the fences off: the lines they held stay, in the page's direction. */
function unwrapBlock(state: EditorState, span: BlockSpan): TransactionSpec {
  const doc = state.doc;
  const open = doc.line(span.openLine);
  // The opening line goes with the break after it.
  const changes = [{ from: open.from, to: Math.min(open.to + 1, doc.length) }];
  if (span.closeLine !== 0) {
    const close = doc.line(span.closeLine);
    // The closing line goes with a break of its own. At the end of the
    // document the break is the one above it, so the last body line is not
    // left ending in an empty one.
    if (close.number < doc.lines) {
      changes.push({ from: close.from, to: close.to + 1 });
    } else if (close.from > open.to) {
      changes.push({ from: Math.max(open.to + 1, close.from - 1), to: close.to });
    }
  }
  return { changes, scrollIntoView: true, userEvent: "hook.direction" };
}

/**
 * The toolbar's direction button.
 *
 * With a caret it changes the document's default: `::meta{direction=rtl}` on
 * the top line, or off again. With a selection it wraps the selected lines in
 * `:::rtl` … `:::`, and a second press inside that wrapper takes it off: the
 * wrapper is the passage's setting, and the button is how it goes away.
 */
export function toggleDirection(state: EditorState): TransactionSpec {
  const span = directionSpan(state);
  if (span) return unwrapBlock(state, span);
  const direction: TextDirection = documentDirection(state) === "rtl" ? "ltr" : "rtl";
  if (state.selection.main.empty) return setDocumentDirection(state, direction);
  const rule = ruleFor(direction, "block");
  return rule ? wrapBlock(state, rule) : { changes: [] };
}

/** The link under a position, for the editor's hover card. */
export function linkAt(
  state: EditorState,
  position: number,
): { from: number; to: number; href: string; hostname: string } | null {
  for (const construct of constructsBetween(state, position, position)) {
    if (construct.className !== "cm-link" || !construct.href) continue;
    try {
      const url = new URL(construct.href);
      return { from: construct.openTo, to: construct.closeFrom, href: construct.href, hostname: url.hostname };
    } catch {
      return null;
    }
  }
  return null;
}
