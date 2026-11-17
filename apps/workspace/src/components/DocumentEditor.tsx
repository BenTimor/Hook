import { useEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { history, historyKeymap, indentWithTab, defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import type { DocumentMeta } from "../lib/types";

/**
 * The document editor.
 *
 * The Markdown buffer is the document — there is no rich-text representation to
 * convert to and from, so what an agent writes is exactly what a person sees.
 * "Live preview" is a layer of decorations over that buffer: headings, bold,
 * inline code and links are styled, and their markup is hidden until the cursor
 * is on the line. The Raw toggle removes the layer; the text is untouched.
 */

export interface DocumentEditorHandle {
  markdown: () => string;
}

export function DocumentEditor({
  document,
  raw,
  readOnly,
  forceSave = 0,
  onChange,
  onSave,
}: {
  document: DocumentMeta;
  raw: boolean;
  readOnly: boolean;
  /** Increment to save the current buffer now (used after a conflict choice). */
  forceSave?: number;
  onChange: (dirty: boolean) => void;
  onSave: (markdown: string) => Promise<boolean>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const rawCompartment = useRef(new Compartment());
  const saveRef = useRef(onSave);
  const changeRef = useRef(onChange);
  saveRef.current = onSave;
  changeRef.current = onChange;

  // A document swap replaces the whole state; the same document re-rendering
  // must not reset the cursor.
  const documentId = document.id;
  const initial = useRef(document.markdown ?? "");

  useEffect(() => {
    initial.current = document.markdown ?? "";
  }, [documentId, document.markdown]);

  /** Save after a pause; the parent owns the revision the write is based on. */
  const scheduleTimer = useRef<number | null>(null);
  const schedule = (text: string, immediately = false) => {
    if (scheduleTimer.current !== null) window.clearTimeout(scheduleTimer.current);
    if (immediately) {
      void saveRef.current(text).then((saved) => {
        if (saved) changeRef.current(false);
      });
      return;
    }
    scheduleTimer.current = window.setTimeout(() => {
      void saveRef.current(text).then((saved) => {
        if (saved) changeRef.current(false);
      });
    }, 900);
  };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: initial.current,
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-b", run: (target) => toggleWrap(target, "**") },
          { key: "Mod-i", run: (target) => toggleWrap(target, "*") },
          { key: "Mod-k", run: (target) => insertLink(target) },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        markdown({ base: markdownLanguage, addKeymap: false }),
        rawCompartment.current.of(raw ? [] : livePreview),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) changeRef.current(true);
          if (update.docChanged) schedule(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "15px" },
          ".cm-scroller": {
            fontFamily: "var(--font-sans)",
            lineHeight: "1.7",
            padding: "8px 0 40px",
          },
          ".cm-content": { padding: "0 24px", maxWidth: "760px", margin: "0 auto" },
          ".cm-line": { padding: "0 4px" },
          "&.cm-focused": { outline: "none" },
          ".cm-cursor": { borderLeftColor: "var(--accent)" },
          "&.cm-focused .cm-selectionBackground, ::selection": {
            background: "rgba(var(--accent-rgb), 0.14)",
          },
        }),
      ],
    });
    const instance = new EditorView({ state, parent: host.current });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // A new document must start from a fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, readOnly]);

  // "Keep mine" after a conflict: save the buffer again against the revision
  // the server just handed back.
  useEffect(() => {
    if (!forceSave) return;
    const instance = view.current;
    if (instance) schedule(instance.state.doc.toString(), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceSave]);

  // Toggling raw mode swaps only the decoration layer.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    instance.dispatch({
      effects: rawCompartment.current.reconfigure(raw ? [] : livePreview),
    });
  }, [raw]);

  return <div className="ws-editor" ref={host} />;
}


// ── Live preview decorations ─────────────────────────────────────────────────

const mark = (className: string) => Decoration.mark({ class: className });
const hide = Decoration.replace({});

const HEADINGS = [
  /* level 1 */ Decoration.line({ class: "cm-h1" }),
  Decoration.line({ class: "cm-h2" }),
  Decoration.line({ class: "cm-h3" }),
  Decoration.line({ class: "cm-h4" }),
  Decoration.line({ class: "cm-h5" }),
  Decoration.line({ class: "cm-h6" }),
];

/** Built from a syntax tree? No — Markdown is regular enough for a line scan. */
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const cursorLine = doc.lineAt(head).number;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      // The line being edited shows its markup, like every other Markdown
      // editor worth using: you can always see and fix the syntax.
      if (line.number !== cursorLine) {
        decorateLine(builder, line.from, line.text);
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function decorateLine(
  builder: RangeSetBuilder<Decoration>,
  offset: number,
  text: string,
) {
  const heading = /^(#{1,6})\s+/.exec(text);
  if (heading) {
    builder.add(offset, offset, HEADINGS[heading[1].length - 1]);
    builder.add(offset, offset + heading[0].length, hide);
    addInline(builder, offset + heading[0].length, text.slice(heading[0].length));
    return;
  }
  if (/^>\s+/.test(text)) {
    builder.add(offset, offset + 2, hide);
    addInline(builder, offset + 2, text.slice(2));
    return;
  }
  if (/^[-*+]\s+/.test(text) || /^\d+\.\s+/.test(text)) {
    const match = /^([-*+]\s+|\d+\.\s+)/.exec(text)!;
    builder.add(offset, offset + match[0].length, Decoration.replace({}));
    addInline(builder, offset + match[0].length, text.slice(match[0].length));
    return;
  }
  addInline(builder, offset, text);
}

const INLINE = [
  { pattern: /\*\*([^*]+)\*\*/g, klass: "cm-strong", delimiters: 2 },
  { pattern: /__([^_]+)__/g, klass: "cm-strong", delimiters: 2 },
  { pattern: /(?<!\*)\*([^*]+)\*(?!\*)/g, klass: "cm-em", delimiters: 1 },
  { pattern: /(?<!_)_([^_]+)_(?!_)/g, klass: "cm-em", delimiters: 1 },
  { pattern: /`([^`]+)`/g, klass: "cm-code", delimiters: 1 },
  { pattern: /~~([^~]+)~~/g, klass: "cm-strike", delimiters: 2 },
];

function addInline(builder: RangeSetBuilder<Decoration>, offset: number, text: string) {
  type Range = { from: number; to: number; decoration: Decoration };
  const ranges: Range[] = [];

  for (const { pattern, klass, delimiters } of INLINE) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      const start = offset + match.index;
      const innerStart = start + delimiters;
      const innerEnd = start + match[0].length - delimiters;
      ranges.push({ from: start, to: innerStart, decoration: hide });
      ranges.push({ from: innerEnd, to: start + match[0].length, decoration: hide });
      ranges.push({ from: innerStart, to: innerEnd, decoration: mark(klass) });
      match = pattern.exec(text);
    }
  }

  // Links: keep the label, hide the brackets and the target.
  const link = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match = link.exec(text);
  while (match) {
    const start = offset + match.index;
    const labelStart = start + 1;
    const labelEnd = labelStart + match[1].length;
    ranges.push({ from: start, to: labelStart, decoration: hide });
    ranges.push({
      from: labelEnd,
      to: start + match[0].length,
      decoration: hide,
    });
    ranges.push({ from: labelStart, to: labelEnd, decoration: mark("cm-link") });
    match = link.exec(text);
  }

  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  let last = offset;
  for (const range of ranges) {
    if (range.from < last) continue; // overlapping matches: keep the first
    if (range.from > range.to) continue;
    builder.add(range.from, range.to, range.decoration);
    last = range.to;
  }
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

// ── Shortcuts ────────────────────────────────────────────────────────────────

function toggleWrap(view: EditorView, marker: string): boolean {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  const before = view.state.sliceDoc(Math.max(0, from - marker.length), from);
  const after = view.state.sliceDoc(to, to + marker.length);
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from },
        { from: to, to: to + marker.length },
      ],
      selection: { anchor: from - marker.length, head: to - marker.length },
    });
    return true;
  }
  if (text.startsWith(marker) && text.endsWith(marker) && text.length > marker.length * 2) {
    view.dispatch({
      changes: { from, to, insert: text.slice(marker.length, -marker.length) },
    });
    return true;
  }
  view.dispatch({
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    selection: { anchor: from + marker.length, head: to + marker.length },
  });
  return true;
}

function insertLink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const label = view.state.sliceDoc(from, to) || "link text";
  const insert = `[${label}](url)`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + label.length + 3, head: from + label.length + 6 },
  });
  return true;
}

/** Unused but useful when the editor grows collaboration support. */
export const externalChange = Annotation.define<boolean>();
export const revField = StateField.define<number>({
  create: () => 0,
  update: (value) => value,
});
