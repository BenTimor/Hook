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
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { history, historyKeymap, indentWithTab, defaultKeymap, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { Bold, Italic, Heading1, Heading2, Heading3, Link, List, ListOrdered, ListTodo, Quote, Code, CodeXml, Strikethrough, Minus, Table2, Undo2, Redo2 } from "lucide-react";

import type { DocumentMeta } from "../lib/types";

/**
 * The document editor.
 *
 * The Markdown buffer is the document — there is no rich-text representation to
 * convert to and from, so what an agent writes is exactly what a person sees.
 * "Live preview" is a layer of decorations over that buffer: headings, bold,
 * inline code and links are styled, with their markup hidden in the formatted
 * editor. Source mode removes the layer; the text is untouched.
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
        EditorState.readOnly.of(readOnly),
        placeholder(readOnly ? "This document is empty." : "Start writing your document…"),
        markdown({ base: markdownLanguage, addKeymap: false }),
        rawCompartment.current.of(raw ? [] : [livePreview, tablePreview]),
        EditorView.domEventHandlers({
          mousedown(event, editor) {
            if (event.button !== 0 || editor.state.readOnly ||
                (event.target !== editor.contentDOM && event.target !== editor.scrollDOM)) return false;
            const end = editor.state.doc.length;
            let endsWithTable = false;
            editor.state.field(tablePreview, false)?.between(end, end, (_from, to) => {
              if (to === end) endsWithTable = true;
            });
            const tables = editor.contentDOM.querySelectorAll(".cm-table-preview");
            const lastTable = tables.item(tables.length - 1);
            if (!endsWithTable || !lastTable || event.clientY <= lastTable.getBoundingClientRect().bottom) return false;
            event.preventDefault();
            editor.dispatch({ changes: { from: end, insert: "\n" }, selection: { anchor: end + 1 } });
            editor.focus();
            return true;
          },
        }),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) changeRef.current(true);
          if (update.docChanged) schedule(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "15px" },
          ".cm-scroller": {
            fontFamily: "var(--font-sans)",
            lineHeight: "1.7",
            padding: "48px 0 56px",
          },
          ".cm-content": { padding: "0 24px", maxWidth: "760px", margin: "0 auto", userSelect: "text" },
          ".cm-line": { padding: "0 4px" },
          "&.cm-focused": { outline: "none" },
          ".cm-cursor": { borderLeftColor: "var(--accent)" },
          "&.cm-focused .cm-selectionBackground, ::selection": {
            background: "rgba(var(--accent-rgb), 0.28)",
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

  // A development hot update can replace the host while preserving the editor.
  // Move the existing view into the current host so its unsaved buffer survives.
  useEffect(() => {
    const instance = view.current;
    if (instance && host.current && instance.dom.parentElement !== host.current) {
      host.current.appendChild(instance.dom);
      instance.requestMeasure();
    }
  });

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
      effects: rawCompartment.current.reconfigure(raw ? [] : [livePreview, tablePreview]),
    });
  }, [raw]);

  const tools = [
    { label: "Undo", Icon: Undo2, run: undo },
    { label: "Redo", Icon: Redo2, run: redo },
    { label: "Heading 1", Icon: Heading1, run: (editor: EditorView) => toggleLinePrefix(editor, "heading1") },
    { label: "Heading 2", Icon: Heading2, run: (editor: EditorView) => toggleLinePrefix(editor, "heading2") },
    { label: "Heading 3", Icon: Heading3, run: (editor: EditorView) => toggleLinePrefix(editor, "heading3") },
    { label: "Bold", Icon: Bold, run: (editor: EditorView) => toggleWrap(editor, "**") },
    { label: "Italic", Icon: Italic, run: (editor: EditorView) => toggleWrap(editor, "*") },
    { label: "Strikethrough", Icon: Strikethrough, run: (editor: EditorView) => toggleWrap(editor, "~~") },
    { label: "Link", Icon: Link, run: insertLink },
    { label: "Bulleted list", Icon: List, run: (editor: EditorView) => toggleLinePrefix(editor, "bullet") },
    { label: "Numbered list", Icon: ListOrdered, run: (editor: EditorView) => toggleLinePrefix(editor, "number") },
    { label: "Checklist", Icon: ListTodo, run: (editor: EditorView) => toggleLinePrefix(editor, "check") },
    { label: "Quote", Icon: Quote, run: (editor: EditorView) => toggleLinePrefix(editor, "quote") },
    { label: "Inline code", Icon: Code, run: (editor: EditorView) => toggleWrap(editor, "`") },
    { label: "Code block", Icon: CodeXml, run: insertCodeBlock },
    { label: "Divider", Icon: Minus, run: (editor: EditorView) => insertBlock(editor, "---") },
    { label: "Table", Icon: Table2, run: (editor: EditorView) => insertBlock(editor, "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |") },
  ];
  return (
    <div className="ws-editor-shell">
      <div className="ws-editor-toolbar" role="toolbar" aria-label="Document formatting">
        {tools.map(({ label, Icon, run }) => (
          <button key={label} className="ws-editor-tool" type="button" title={label} aria-label={label} disabled={readOnly}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { if (view.current) { run(view.current); view.current.focus(); } }}>
            <Icon aria-hidden="true" />
          </button>
        ))}
        {readOnly && <span className="ws-editor-readonly">View only</span>}
      </div>
      <div className="ws-editor" data-source={raw} ref={host} />
    </div>
  );
}


// ── Live preview decorations ─────────────────────────────────────────────────

const mark = (className: string) => Decoration.mark({ class: className });
const hide = Decoration.replace({});
const codeLine = Decoration.line({ class: "cm-code-block-line" });
const ruleLine = Decoration.line({ class: "cm-rule" });

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

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      let node = syntaxTree(view.state).resolveInner(line.from, 1);
      while (node.parent && node.name !== "FencedCode" && node.name !== "CodeBlock") node = node.parent;
      const codeBlock = node.name === "FencedCode" || node.name === "CodeBlock";
      if (codeBlock) builder.add(line.from, line.from, codeLine);
      else decorateLine(builder, line.from, line.text);
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
  if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
    builder.add(offset, offset, ruleLine);
    builder.add(offset, offset + text.length, hide);
    return;
  }
  const heading = /^(#{1,6})\s+/.exec(text);
  if (heading) {
    builder.add(offset, offset, HEADINGS[heading[1].length - 1]);
    builder.add(offset, offset + heading[0].length, hide);
    addInline(builder, offset + heading[0].length, text.slice(heading[0].length));
    return;
  }
  if (/^>\s+/.test(text)) {
    builder.add(offset, offset, Decoration.line({ class: "cm-quote" }));
    builder.add(offset, offset + 2, hide);
    addInline(builder, offset + 2, text.slice(2));
    return;
  }
  if (/^[-*+]\s+/.test(text) || /^\d+\.\s+/.test(text)) {
    const match = /^([-*+]\s+|\d+\.\s+)/.exec(text)!;
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
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

// Table cells edit the Markdown buffer directly while keeping the table visible.

function tableCells(text: string): string[] {
  const cells: string[] = [];
  let cell = "", ticks = 0;
  const line = text.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) {
      cell += line[i] + line[++i];
    } else if (line[i] === "`") {
      let end = i;
      while (line[end] === "`") end++;
      const count = end - i;
      ticks = ticks === count ? 0 : ticks || count;
      cell += line.slice(i, end);
      i = end - 1;
    } else if (line[i] === "|" && !ticks) {
      cells.push(cell.trim());
      cell = "";
    } else cell += line[i];
  }
  cells.push(cell.trim());
  return cells;
}

class TableWidget extends WidgetType {
  constructor(readonly rows: string[][], readonly align: string[], readonly from: number, readonly readOnly: boolean) { super(); }
  eq(other: TableWidget) { return this.from === other.from && this.readOnly === other.readOnly && JSON.stringify(this.rows) === JSON.stringify(other.rows) && JSON.stringify(this.align) === JSON.stringify(other.align); }
  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-table-preview";
    wrapper.dataset.from = String(this.from);
    const table = document.createElement("table");
    table.setAttribute("aria-label", "Markdown table");
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    this.rows.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      for (let i = 0; i < this.align.length; i++) {
        const cell = document.createElement(rowIndex === 0 ? "th" : "td");
        cell.textContent = (row[i] ?? "").replace(/\\\|/g, "|");
        cell.style.textAlign = this.align[i];
        if (!this.readOnly) {
          cell.contentEditable = "true";
          cell.setAttribute("role", "textbox");
          cell.setAttribute("aria-label", `${rowIndex === 0 ? "Column heading" : `Row ${rowIndex}, column`} ${i + 1}`);
          cell.addEventListener("input", (event) => {
            event.stopPropagation();
            const start = Number(wrapper.dataset.from);
            const header = view.state.doc.lineAt(start);
            const lineNumber = header.number + (rowIndex === 0 ? 0 : rowIndex + 1);
            if (lineNumber > view.state.doc.lines) return;
            const line = view.state.doc.line(lineNumber);
            const cells = tableCells(line.text);
            while (cells.length < this.align.length) cells.push("");
            cells[i] = (cell.textContent ?? "").replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|");
            view.dispatch({ changes: { from: line.from, to: line.to, insert: `| ${cells.join(" | ")} |` } });
          });
          cell.addEventListener("keydown", (event) => {
            event.stopPropagation();
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
              event.preventDefault();
              const range = document.createRange();
              range.selectNodeContents(cell);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            }
            if (event.key === "Enter") event.preventDefault();
          });
          cell.addEventListener("beforeinput", (event) => event.stopPropagation());
          cell.addEventListener("paste", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const text = event.clipboardData?.getData("text/plain").replace(/\r?\n/g, " ") ?? "";
            document.execCommand("insertText", false, text);
          });
        }
        tr.appendChild(cell);
      }
      (rowIndex === 0 ? head : body).appendChild(tr);
    });
    table.append(head, body);
    wrapper.appendChild(table);
    return wrapper;
  }
  updateDOM(dom: HTMLElement) {
    if ((dom.querySelectorAll("tr").length !== this.rows.length) ||
      dom.querySelector("tr")?.children.length !== this.align.length) return false;
    dom.dataset.from = String(this.from);
    dom.querySelectorAll("tr").forEach((tr, rowIndex) => {
      tr.querySelectorAll<HTMLElement>("th, td").forEach((cell, index) => {
        const text = (this.rows[rowIndex][index] ?? "").replace(/\\\|/g, "|");
        if (cell !== document.activeElement && cell.textContent !== text) cell.textContent = text;
        cell.style.textAlign = this.align[index];
      });
    });
    return true;
  }
}

const tablePreview = StateField.define<DecorationSet>({
  create(state) { return buildTables(state); },
  update(value, transaction) { return transaction.docChanged ? buildTables(transaction.state) : value; },
  provide: (field) => EditorView.decorations.from(field),
});

function buildTables(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state);
  for (let number = 1; number < doc.lines; number++) {
    const header = doc.line(number), divider = doc.line(number + 1);
    if (!header.text.includes("|") || !divider.text.includes("|")) continue;
    let node = tree.resolveInner(header.from, 1);
    while (node.parent && node.name !== "FencedCode" && node.name !== "CodeBlock") node = node.parent;
    if (node.name === "FencedCode" || node.name === "CodeBlock") continue;
    const columns = tableCells(header.text), rules = tableCells(divider.text);
    if (columns.length !== rules.length || !rules.every((rule) => /^:?-{3,}:?$/.test(rule))) continue;
    const rows = [columns];
    let last = number + 1;
    while (last < doc.lines && doc.line(last + 1).text.trim() && doc.line(last + 1).text.includes("|")) {
      rows.push(tableCells(doc.line(++last).text));
    }
    const end = doc.line(last).to;
    const align = rules.map((rule) => rule.startsWith(":") && rule.endsWith(":") ? "center" : rule.endsWith(":") ? "right" : "left");
    builder.add(header.from, end, Decoration.replace({ block: true, widget: new TableWidget(rows, align, header.from, state.readOnly) }));
    number = last;
  }
  return builder.finish();
}

// ── Shortcuts ────────────────────────────────────────────────────────────────

function toggleWrap(view: EditorView, marker: string): boolean {
  if (view.state.readOnly) return false;
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
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const label = view.state.sliceDoc(from, to) || "link text";
  const insert = `[${label}](url)`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + label.length + 3, head: from + label.length + 6 },
  });
  return true;
}

function toggleLinePrefix(view: EditorView, kind: "heading1" | "heading2" | "heading3" | "bullet" | "number" | "check" | "quote"): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const first = view.state.doc.lineAt(from);
  const last = view.state.doc.lineAt(to > from ? to - 1 : to);
  const patterns = { heading1: /^#{1,6}\s+/, heading2: /^#{1,6}\s+/, heading3: /^#{1,6}\s+/, bullet: /^[-*+]\s+(?!\[[ xX]\]\s)/, number: /^\d+\.\s+/, check: /^[-*+]\s+\[[ xX]\]\s+/, quote: /^>\s+/ };
  const prefix = { heading1: "# ", heading2: "## ", heading3: "### ", bullet: "- ", number: "1. ", check: "- [ ] ", quote: "> " };
  const lines = Array.from({ length: last.number - first.number + 1 }, (_, index) => view.state.doc.line(first.number + index));
  const heading = kind.startsWith("heading");
  const remove = lines.every((line) => heading ? line.text.startsWith(prefix[kind]) : patterns[kind].test(line.text));
  const changes = lines.map((line, index) => {
    const match = patterns[kind].exec(line.text);
    const insert = kind === "number" ? `${index + 1}. ` : prefix[kind];
    if (remove) return { from: line.from, to: line.from + match![0].length, insert: "" };
    if (match && !heading) return { from: line.from, to: line.from, insert: "" };
    return { from: line.from, to: line.from + (heading && match ? match[0].length : 0), insert };
  });
  view.dispatch({ changes });
  return true;
}

function insertBlock(view: EditorView, block: string): boolean {
  if (view.state.readOnly) return false;
  const pos = view.state.doc.lineAt(view.state.selection.main.to).to;
  const before = pos ? "\n\n" : "";
  const insert = `${before}${block}\n`;
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
  return true;
}

function insertCodeBlock(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const longest = Math.max(2, ...(selected.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const before = from && view.state.sliceDoc(from - 1, from) !== "\n" ? "\n\n" : "";
  const after = to < view.state.doc.length && view.state.sliceDoc(to, to + 1) !== "\n" ? "\n\n" : "\n";
  const prefix = `${before}${fence}\n`;
  view.dispatch({ changes: { from, to, insert: `${prefix}${selected}\n${fence}${after}` }, selection: { anchor: from + prefix.length, head: from + prefix.length + selected.length } });
  return true;
}

/** Unused but useful when the editor grows collaboration support. */
export const externalChange = Annotation.define<boolean>();
export const revField = StateField.define<number>({
  create: () => 0,
  update: (value) => value,
});
