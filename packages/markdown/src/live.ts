import {
  EditorSelection,
  EditorState,
  type Extension,
  type Range,
  type Text,
  type Transaction,
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
const CALLOUT_OPEN = /^( {0,3})(:{3,})([A-Za-z][\w-]*)(?:\[([^\]\n]*)\])?\s*$/;
const CALLOUT_CLOSE = /^( {0,3})(:{3,})\s*$/;

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

// ── Callouts ─────────────────────────────────────────────────────────────────

interface CalloutSpan {
  rule: Rule;
  /** How many colons open it; a closer needs at least as many. */
  fence: number;
  openLine: number;
  openFrom: number;
  /** Start of the label, or the end of the name when there is none. */
  labelFrom: number;
  labelTo: number;
  /** Where the label's `]` sits, or `labelTo` when there are no brackets. */
  labelEnd: number;
  closeLine: number;
  closeFrom: number;
  closeTo: number;
}

const calloutCache = new WeakMap<Text, CalloutSpan[]>();

/**
 * Every `:::name` block, innermost closers applied first. This scan deliberately
 * does not know about fenced code: `micromark` closes a container at a line of
 * colons whatever surrounds it, and the editor has to draw what the page shows.
 */
function calloutSpans(doc: Text): CalloutSpan[] {
  const cached = calloutCache.get(doc);
  if (cached) return cached;
  const spans: CalloutSpan[] = [];
  const open: CalloutSpan[] = [];

  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    const colon = line.text.search(/\S/);
    if (colon < 0 || line.text[colon] !== ":") continue;

    const opener = CALLOUT_OPEN.exec(line.text);
    if (opener) {
      const rule = ruleFor(opener[3], "block");
      if (!rule) continue;
      const indent = opener[1].length;
      const nameEnd = indent + opener[2].length + opener[3].length;
      const label = opener[4];
      const span: CalloutSpan = {
        rule,
        fence: opener[2].length,
        openLine: number,
        openFrom: line.from + indent,
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

    const closer = CALLOUT_CLOSE.exec(line.text);
    if (!closer) continue;
    while (open.length > 0 && open[open.length - 1].fence <= closer[2].length) {
      const span = open.pop() as CalloutSpan;
      span.closeLine = number;
      span.closeFrom = line.from + closer[1].length;
      span.closeTo = line.to;
    }
  }

  calloutCache.set(doc, spans);
  return spans;
}

/** The innermost callout covering a line, fences included. */
function spanAt(spans: readonly CalloutSpan[], number: number): CalloutSpan | null {
  let found: CalloutSpan | null = null;
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

  const emit = (constructs: readonly Construct[], map: (offset: number) => number) => {
    for (const construct of constructs) {
      const from = map(construct.from);
      const to = map(construct.to);
      if (construct.kind === "replace") {
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

  const spans = calloutSpans(doc);

  for (const visible of ranges) {
    let number = doc.lineAt(Math.min(visible.from, doc.length)).number;
    const lastLine = doc.lineAt(Math.min(visible.to, doc.length)).number;
    // A paragraph that started above the viewport must still parse as one block.
    while (number > 1 && continues(doc.line(number - 1).text, doc.line(number).text)) number -= 1;

    while (number <= lastLine) {
      const line = doc.line(number);
      const info = shape(line.text);
      const span = spanAt(spans, number);

      if (isCode(state, line.from)) {
        mark(line.from, "cm-code-block-line");
        number += 1;
        continue;
      }

      if (span && span.openLine === number) {
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
        number += 1;
        continue;
      }

      if (span && span.closeLine === number) {
        mark(line.from, "cm-callout-close");
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
        if (span) {
          const end = span.closeLine === 0 ? doc.lines : span.closeLine - 1;
          mark(
            line.from,
            "cm-callout-body",
            number === span.openLine + 1 && "cm-callout-body-first",
            number === end && "cm-callout-body-last",
          );
        }
        number += 1;
        continue;
      }

      if (info.kind === "blank") {
        if (span) mark(line.from, "cm-callout-body");
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
        const end = span.closeLine === 0 ? doc.lines : span.closeLine - 1;
        for (let inner = unit.first; inner <= unit.last; inner += 1) {
          mark(
            doc.line(inner).from,
            "cm-callout-body",
            inner === span.openLine + 1 && "cm-callout-body-first",
            inner === end && "cm-callout-body-last",
          );
        }
      }
      emit(parseInline(unit.text), (offset) => toDoc(unit, offset));
      number = unit.last + 1;
    }
  }

  for (const [position, classes] of lineClasses) {
    add(position, position, Decoration.line({ class: classes.join(" ") }));
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
        if (!update.docChanged && !update.viewportChanged) return;
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
    EditorState.transactionFilter.of((transaction) => repairTransaction(transaction)),
    EditorState.transactionFilter.of((transaction) => settleSelection(transaction)),
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
    if (construct.kind !== "replace" || !construct.image) continue;
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

  for (const span of calloutSpans(doc)) {
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

/** The callout button: fence the selection, or an empty block at the cursor. */
export function wrapCallout(state: EditorState, rule: Rule): TransactionSpec {
  const selection = state.selection.main;
  const doc = state.doc;
  const from = doc.lineAt(selection.from).from;
  const to = doc.lineAt(selection.to).to;
  const body = doc.sliceString(from, to);
  const name = canonical(rule);
  const title = rule.defaultLabel ?? "Note";
  const head = `:::${name}[${title}]`;
  const text = body.trim() ? `${head}\n${body}\n:::` : `${head}\n\n:::`;
  const titleFrom = from + 3 + name.length + 1;
  return {
    changes: { from, to, insert: text },
    selection: EditorSelection.range(titleFrom, titleFrom + title.length),
    scrollIntoView: true,
    userEvent: "input",
  };
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
