import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, TextFieldDialog } from "@hook/ui";
import {
  applyRule,
  documentDirection,
  linkAt,
  livePreview,
  renderMath,
  ruleFor,
  toggleDirection,
  wrapBlock,
  type Rule,
  type TextDirection,
} from "@hook/markdown";
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
  WidgetType,
  hoverTooltip,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { history, historyKeymap, indentWithTab, defaultKeymap, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { ArrowLeftRight, Bold, Italic, Underline, Highlighter, Heading1, Heading2, Heading3, Info, Link, List, ListOrdered, ListTodo, Quote, Code, CodeXml, Strikethrough, Minus, Table2, Undo2, Redo2, ALargeSmall, ImagePlus } from "lucide-react";

import { openExternal } from "../lib/bridge";
import { documentImageSource, embedDocumentImage } from "../lib/documentImages";

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

const MAX_MARKDOWN_BYTES = 512 * 1024;

function transferredImages(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files).filter((file) => file.type.startsWith("image/"));
  if (files.length) return files;
  return Array.from(transfer.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function imageMarkdown(source: string, description: string): string {
  const alt = (description || "Image").replace(/[\r\n]/g, " ").replace(/[\\\[\]]/g, "\\$&");
  const destination = source.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `![${alt}](${destination})`;
}

function imageSizeError() {
  return new Error("These images would exceed the 512 KB text limit. Try smaller files or use links.");
}

export function DocumentEditor({
  document,
  raw,
  readOnly,
  forceSave = 0,
  onChange,
  onSave,
  compact = false,
}: {
  document: { id: string; markdown?: string };
  raw: boolean;
  readOnly: boolean;
  /** Increment to save the current buffer now (used after a conflict choice). */
  forceSave?: number;
  onChange: (dirty: boolean) => void;
  onSave: (markdown: string) => Promise<boolean>;
  compact?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  // The document's own text direction, from its `::meta{direction=…}` line: it
  // is part of the Markdown, so it is saved with it and needs no column.
  const [direction, setDirection] = useState<TextDirection>("ltr");
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageAlt, setImageAlt] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageError, setImageError] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [colorMenu, setColorMenu] = useState<{ top: number; left: number } | null>(null);
  const colorButton = useRef<HTMLButtonElement>(null);
  const colorPopover = useRef<HTMLDivElement>(null);
  const linkSelection = useRef<{ from: number; to: number; label?: string } | null>(null);
  const view = useRef<EditorView | null>(null);
  const pendingImages = useRef<{ editor: EditorView; position: number } | null>(null);
  const rawCompartment = useRef(new Compartment());
  const directionCompartment = useRef(new Compartment());
  const saveRef = useRef(onSave);
  const changeRef = useRef(onChange);
  const directionRef = useRef(direction);
  saveRef.current = onSave;
  changeRef.current = onChange;
  directionRef.current = direction;

  // A document swap replaces the whole state; the same document re-rendering
  // must not reset the cursor.
  const documentId = document.id;
  const initial = useRef(document.markdown ?? "");

  useEffect(() => {
    initial.current = document.markdown ?? "";
  }, [documentId, document.markdown]);

  useEffect(() => {
    if (!colorMenu) return;
    const close = (event: PointerEvent) => {
      if (!colorButton.current?.contains(event.target as Node) && !colorPopover.current?.contains(event.target as Node)) setColorMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setColorMenu(null); colorButton.current?.focus(); }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [colorMenu]);

  /** Save after a pause; the parent owns the revision the write is based on. */
  const scheduleTimer = useRef<number | null>(null);
  const editVersion = useRef(0);
  const schedule = (text: string, immediately = false) => {
    const version = ++editVersion.current;
    if (scheduleTimer.current !== null) window.clearTimeout(scheduleTimer.current);
    if (immediately) {
      void saveRef.current(text).then((saved) => {
        if (saved && version === editVersion.current) changeRef.current(false);
      });
      return;
    }
    scheduleTimer.current = window.setTimeout(() => {
      scheduleTimer.current = null;
      void saveRef.current(text).then((saved) => {
        if (saved && version === editVersion.current) changeRef.current(false);
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
          { key: "Mod-k", run: (target) => { openLink(target); return true; } },
          { key: "Mod-u", run: (target) => markSelection(target, "underline") },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.lineWrapping,
        directionCompartment.current.of(
          EditorView.contentAttributes.of({ dir: direction }),
        ),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        placeholder(readOnly ? "This document is empty." : compact ? "Add a description…" : "Start writing your document…"),
        markdown({ base: markdownLanguage, addKeymap: false }),
        rawCompartment.current.of(raw ? [] : formattedExtensions),
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
          const pending = pendingImages.current;
          if (update.docChanged && pending?.editor === update.view) {
            pending.position = update.changes.mapPos(pending.position, 1);
          }
          if (update.docChanged) changeRef.current(true);
          if (update.docChanged) schedule(update.state.doc.toString());
          // An undo, or a paste carrying a metadata line, can change the
          // document's direction under the editor; follow it.
          const next = documentDirection(update.state);
          if (next !== directionRef.current) setDirection(next);
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
    // A document swap brings its own direction with it.
    directionRef.current = documentDirection(state);
    setDirection(directionRef.current);
    return () => {
      if (compact && scheduleTimer.current !== null) {
        window.clearTimeout(scheduleTimer.current);
        scheduleTimer.current = null;
        void saveRef.current(instance.state.doc.toString());
      }
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
      effects: rawCompartment.current.reconfigure(raw ? [] : formattedExtensions),
    });
  }, [raw]);

  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    instance.dispatch({
      effects: directionCompartment.current.reconfigure(
        EditorView.contentAttributes.of({ dir: direction }),
      ),
    });
  }, [direction]);

  const openLink = (editor: EditorView) => {
    if (editor.state.readOnly) return;
    const { from, to } = editor.state.selection.main;
    const line = editor.state.doc.lineAt(from);
    const nested = /\[\[([^\]]+)\]\(([^)]*)\)\]\(([^)]*)\)/g;
    const links = /\[([^\[\]]+)\]\(([^)]*)\)/g;
    const match = [...line.text.matchAll(nested), ...line.text.matchAll(links)].find((item) => {
      const start = line.from + item.index!;
      return from >= start && to <= start + item[0].length;
    });
    if (match) {
      const start = line.from + match.index!;
      linkSelection.current = { from: start, to: start + match[0].length, label: match[1] };
      setLinkUrl(match[2] === "url" ? "" : match[2]);
    } else {
      linkSelection.current = { from, to };
      setLinkUrl("");
    }
    setLinkOpen(true);
  };

  const tools = [
    { label: "Undo", Icon: Undo2, run: undo },
    { label: "Redo", Icon: Redo2, run: redo },
    { label: "Heading 1", Icon: Heading1, run: (editor: EditorView) => toggleLinePrefix(editor, "heading1") },
    { label: "Heading 2", Icon: Heading2, run: (editor: EditorView) => toggleLinePrefix(editor, "heading2") },
    { label: "Heading 3", Icon: Heading3, run: (editor: EditorView) => toggleLinePrefix(editor, "heading3") },
    { label: "Bold", Icon: Bold, run: (editor: EditorView) => toggleWrap(editor, "**") },
    { label: "Italic", Icon: Italic, run: (editor: EditorView) => toggleWrap(editor, "*") },
    { label: "Underline", Icon: Underline, run: (editor: EditorView) => markSelection(editor, "underline") },
    { label: "Highlight", Icon: Highlighter, run: (editor: EditorView) => markSelection(editor, "mark") },
    { label: "Strikethrough", Icon: Strikethrough, run: (editor: EditorView) => toggleWrap(editor, "~~") },
    { label: "Link", Icon: Link, run: (editor: EditorView) => { openLink(editor); return true; } },
    { label: "Bulleted list", Icon: List, run: (editor: EditorView) => toggleLinePrefix(editor, "bullet") },
    { label: "Numbered list", Icon: ListOrdered, run: (editor: EditorView) => toggleLinePrefix(editor, "number") },
    { label: "Checklist", Icon: ListTodo, run: (editor: EditorView) => toggleLinePrefix(editor, "check") },
    { label: "Quote", Icon: Quote, run: (editor: EditorView) => toggleLinePrefix(editor, "quote") },
    { label: "Inline code", Icon: Code, run: (editor: EditorView) => toggleWrap(editor, "`") },
    { label: "Code block", Icon: CodeXml, run: insertCodeBlock },
    { label: "Divider", Icon: Minus, run: (editor: EditorView) => insertBlock(editor, "---") },
    { label: "Table", Icon: Table2, run: (editor: EditorView) => insertBlock(editor, "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |") },
    { label: "Callout", Icon: Info, run: insertCallout },
  ];
  const addImages = async (editor: EditorView, position: number, files: File[], url = "", alt = "", fromDialog = false) => {
    if (editor.state.readOnly || pendingImages.current?.editor === editor) return;
    const pending = { editor, position };
    pendingImages.current = pending;
    setImageError("");
    setImageBusy(true);
    try {
      const blocks: string[] = [];
      if (files.length) {
        let embeddedLength = 0;
        for (const file of files) {
          const source = await embedDocumentImage(file);
          if (view.current !== editor) return;
          embeddedLength += source.length;
          if (embeddedLength > MAX_MARKDOWN_BYTES) throw imageSizeError();
          blocks.push(imageMarkdown(source, alt || file.name));
        }
      } else {
        const source = documentImageSource(url.trim());
        if (!source || !/^https?:/i.test(source)) {
          throw new Error("Enter a full image URL starting with https:// or http://.");
        }
        blocks.push(imageMarkdown(source, alt));
      }
      const { state } = editor;
      let pos = state.doc.lineAt(pending.position).to;
      state.field(tablePreview, false)?.between(pos, pos, (_from, to) => {
        pos = Math.max(pos, to);
      });
      const insert = `${pos ? "\n\n" : ""}${blocks.join("\n\n")}\n\n`;
      if (new TextEncoder().encode(insert).length + new TextEncoder().encode(state.doc.toString()).length > MAX_MARKDOWN_BYTES) {
        throw imageSizeError();
      }
      editor.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
      if (fromDialog) {
        setImageOpen(false);
        requestAnimationFrame(() => { if (view.current === editor) editor.focus(); });
      }
    } catch (error) {
      if (view.current === editor) setImageError(error instanceof Error ? error.message : "Could not add the image.");
    } finally {
      if (pendingImages.current === pending) {
        pendingImages.current = null;
        setImageBusy(false);
      }
    }
  };

  return (
    <div className={compact ? "ws-editor-shell ws-editor-compact" : "ws-editor-shell"}>
      <div className="ws-editor-toolbar" role="toolbar" aria-label="Document formatting">
        {tools.map(({ label, Icon, run }) => (
          <button key={label} className="ws-editor-tool" type="button" title={label} aria-label={label} disabled={readOnly}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { if (view.current) { run(view.current); if (label !== "Link") view.current.focus(); } }}>
            <Icon aria-hidden="true" />
          </button>
        ))}
        {!compact ? (
          <button
            type="button"
            className="ws-editor-tool ws-editor-direction"
            aria-label={direction === "rtl" ? "Right-to-left document" : "Left-to-right document"}
            title={
              direction === "rtl"
                ? "Right-to-left document · select text to mark a passage left-to-right"
                : "Left-to-right document · select text to mark a passage right-to-left"
            }
            disabled={readOnly}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const editor = view.current;
              if (!editor) return;
              editor.dispatch(toggleDirection(editor.state));
              editor.focus();
            }}
          >
            <ArrowLeftRight aria-hidden="true" />
            <span>{direction === "rtl" ? "RTL" : "LTR"}</span>
          </button>
        ) : null}
        <button ref={colorButton} type="button" className="ws-editor-tool ws-color-trigger" aria-label="Text color" title="Text color" aria-expanded={Boolean(colorMenu)} disabled={readOnly}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (colorMenu) { setColorMenu(null); return; }
            const rect = colorButton.current?.getBoundingClientRect();
            if (rect) setColorMenu({ top: rect.bottom + 7, left: Math.max(8, Math.min(rect.left, window.innerWidth - 240)) });
          }}><ALargeSmall aria-hidden="true" /><span /></button>
        <button type="button" className="ws-editor-tool" title="Add image" aria-label="Add image" disabled={readOnly || imageBusy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setImageUrl("");
            setImageAlt("");
            setImageFile(null);
            setImageError("");
            setImageOpen(true);
          }}><ImagePlus aria-hidden="true" /></button>
        {readOnly && <span className="ws-editor-readonly">View only</span>}
      </div>
      {colorMenu && createPortal(
        <div ref={colorPopover} className="ws-color-popover" role="group" aria-label="Choose text color" style={{ top: colorMenu.top, left: colorMenu.left }}>
          <div className="ws-color-popover-title">Text color</div>
          <div className="ws-color-options">
            {[
              { name: "Default", color: "" },
              { name: "Green", color: "green" },
              { name: "Blue", color: "blue" },
              { name: "Red", color: "red" },
              { name: "Purple", color: "purple" },
            ].map(({ name, color }) => (
              <button key={name} type="button" aria-label={name} title={name} className={`ws-color-swatch ${color ? `hook-color-${color}` : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const editor = view.current;
                  if (editor) {
                    markColor(editor, color);
                    editor.focus();
                  }
                  setColorMenu(null);
                }}><span aria-hidden="true">A</span></button>
            ))}
          </div>
        </div>, window.document.body
      )}
      {!imageOpen && imageError && <p className="ws-image-error" role="alert">{imageError}</p>}
      <div
        className="ws-editor"
        data-source={raw}
        ref={host}
        onPasteCapture={(event) => {
          const editor = view.current;
          if (!editor || editor.state.readOnly || !editor.contentDOM.contains(event.target as Node)) return;
          const files = transferredImages(event.clipboardData);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          void addImages(editor, editor.state.selection.main.to, files);
        }}
        onDragOverCapture={(event) => {
          if (readOnly || !event.dataTransfer.types.includes("Files")) return;
          const items = Array.from(event.dataTransfer.items);
          if (items.length && !items.some((item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")))) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = imageBusy ? "none" : "copy";
        }}
        onDropCapture={(event) => {
          const editor = view.current;
          if (!editor || editor.state.readOnly) return;
          const files = transferredImages(event.dataTransfer);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          const position = editor.posAtCoords({ x: event.clientX, y: event.clientY }, false);
          editor.focus();
          void addImages(editor, position ?? editor.state.doc.length, files);
        }}
        onKeyDownCapture={(event) => {
          const editor = view.current;
          if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey ||
              event.altKey || event.nativeEvent.isComposing || !editor ||
              event.target !== editor.contentDOM) return;
          if (continueList(editor)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onPointerDownCapture={(event) => {
          // Read Ctrl as the button goes down, before CodeMirror handles selection.
          if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;
          const target = event.target instanceof Element
            ? event.target.closest(".cm-link[data-link-url]")
            : null;
          if (!target || !view.current?.contentDOM.contains(target)) return;
          const url = webLinkUrl(target.getAttribute("data-link-url") ?? "");
          if (!url) return;
          event.preventDefault();
          event.stopPropagation();
          void openExternal(url.href).catch((error) => {
            console.error("Could not open link", error);
            window.alert("Could not open this link. Please check your browser settings and try again.");
          });
        }}
      />
      <Dialog open={imageOpen} title="Add an image" onClose={() => { if (!imageBusy) setImageOpen(false); }}
        footer={<>
          <button type="button" className="btn btn-ghost" disabled={imageBusy} onClick={() => setImageOpen(false)}>Cancel</button>
          <button type="submit" className="btn btn-primary" form={`ws-image-${document.id}`}
            disabled={imageBusy || (!imageFile && !imageUrl.trim())}>{imageBusy ? "Preparing…" : "Insert image"}</button>
        </>}>
        <form id={`ws-image-${document.id}`} className="ws-image-form" onSubmit={(event) => {
          event.preventDefault();
          const editor = view.current;
          if (editor) void addImages(editor, editor.state.selection.main.to, imageFile ? [imageFile] : [], imageUrl, imageAlt.trim(), true);
        }}>
          <label className="dlg-field">
            <span>Image link</span>
            <input className="text-input" value={imageUrl} placeholder="https://example.com/image.png"
              disabled={imageBusy || !!imageFile} onChange={(event) => setImageUrl(event.target.value)} />
          </label>
          <label className="dlg-field">
            <span>Or choose a file</span>
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={imageBusy}
              onChange={(event) => setImageFile(event.target.files?.[0] ?? null)} />
          </label>
          {imageFile && <button className="btn btn-ghost" type="button" disabled={imageBusy} onClick={(event) => {
            const input = event.currentTarget.form?.querySelector<HTMLInputElement>('input[type="file"]');
            if (input) input.value = "";
            setImageFile(null);
          }}>Clear file</button>}
          <label className="dlg-field">
            <span>Image description (optional)</span>
            <input className="text-input" value={imageAlt} disabled={imageBusy} onChange={(event) => setImageAlt(event.target.value)} />
          </label>
          {imageError && <p role="alert">{imageError}</p>}
        </form>
      </Dialog>
      <TextFieldDialog open={linkOpen} title="Add a link" label="Web address" placeholder="https://example.com" value={linkUrl} onChange={setLinkUrl} confirm="Add link" onClose={() => setLinkOpen(false)} onConfirm={() => {
        const editor = view.current;
        const selection = linkSelection.current;
        const input = linkUrl.trim();
        if (!editor || !selection || !input) return;
        const url = /^(?:https?:|mailto:)/i.test(input) ? input : `https://${input}`;
        const label = selection.label ?? (editor.state.sliceDoc(selection.from, selection.to) || input);
        const safeUrl = url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
        const insert = `[${label.replace(/\]/g, "\\]")}](${safeUrl})`;
        editor.dispatch({ changes: { ...selection, insert }, selection: { anchor: selection.from + insert.length } });
        setLinkOpen(false);
        editor.focus();
      }} />
    </div>
  );
}


// ── Widgets ──────────────────────────────────────────────────────────────────

class DocumentImageWidget extends WidgetType {
  constructor(readonly source: string, readonly alt: string) { super(); }
  eq(other: DocumentImageWidget) { return this.source === other.source && this.alt === other.alt; }
  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "ws-document-image";
    const image = document.createElement("img");
    image.alt = this.alt;
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      wrapper.textContent = this.alt ? `Image unavailable: ${this.alt}` : "Image unavailable";
    });
    image.src = this.source;
    wrapper.append(image);
    return wrapper;
  }
}

/** A hand-written `:::note` with no label still needs a heading to show. */
/**
 * A formula in the formatted editor: the maths the page draws, as a widget, so
 * writing a document with `$x^2$` in it does not mean looking at TeX until a
 * preview is opened. The TeX shows instead while the caret is inside the run
 * (`live.ts` decides), so it can always be edited by hand.
 */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM() {
    const html = renderMath(this.tex, this.display);
    const element = document.createElement(this.display ? "div" : "span");
    element.className = this.display ? "cm-math-widget cm-math-display" : "cm-math-widget";
    if (html) element.innerHTML = html;
    else element.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;
    return element;
  }

  ignoreEvent() {
    return false;
  }
}

class CalloutTitleWidget extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(other: CalloutTitleWidget) { return this.label === other.label; }
  toDOM() {
    const title = document.createElement("span");
    title.className = "cm-callout-title";
    title.textContent = this.label;
    return title;
  }
}

function imageWidget({ src, alt }: { src: string; alt: string }) {
  const source = documentImageSource(src);
  return source ? new DocumentImageWidget(source, alt) : null;
}

const linkHover = hoverTooltip((editor, position) => {
  const link = linkAt(editor.state, position);
  if (!link) return null;
  return {
    pos: link.from,
    end: link.to,
    above: false,
    create() {
      const card = document.createElement("div");
      card.className = "ws-link-preview";
      const details = document.createElement("div");
      details.className = "ws-link-preview-details";
      const site = document.createElement("strong");
      site.textContent = link.hostname;
      const address = document.createElement("span");
      address.className = "ws-link-preview-address";
      address.textContent = link.href;
      details.append(site, address);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ws-link-preview-open";
      button.textContent = "Open link ↗";
      button.addEventListener("click", () => {
        void openExternal(link.href).catch(() => { address.textContent = "Could not open this link"; });
      });
      card.append(details, button);
      return { dom: card };
    },
  };
}, { hoverTime: 350, hideOnChange: true });

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

const formattedExtensions = [
  livePreview({
    image: imageWidget,
    math: (math) => new MathWidget(math.tex, math.display),
    calloutTitle: (rule) => new CalloutTitleWidget(rule.defaultLabel ?? ""),
  }),
  tablePreview,
  linkHover,
];

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

/** A toolbar action: the selection becomes a rule, or an existing rule goes. */
function applyToSelection(editor: EditorView, rule: Rule | null, family: string): boolean {
  if (editor.state.readOnly) return false;
  const spec = applyRule(editor.state, rule, family);
  if (!spec) return false;
  editor.dispatch(spec);
  return true;
}

function markSelection(editor: EditorView, family: string): boolean {
  return applyToSelection(editor, ruleFor(family, "inline"), family);
}

function markColor(editor: EditorView, color: string): boolean {
  return applyToSelection(editor, color ? ruleFor(color, "inline") : null, "color");
}

function insertCallout(editor: EditorView): boolean {
  if (editor.state.readOnly) return false;
  const rule = ruleFor("note", "block");
  if (!rule) return false;
  editor.dispatch(wrapBlock(editor.state, rule));
  return true;
}

function webLinkUrl(destination: string): URL | null {
  try {
    const url = new URL(destination);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function toggleWrap(view: EditorView, marker: string, endMarker = marker): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  const before = view.state.sliceDoc(Math.max(0, from - marker.length), from);
  const after = view.state.sliceDoc(to, to + endMarker.length);
  if (before === marker && after === endMarker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from },
        { from: to, to: to + endMarker.length },
      ],
      selection: { anchor: from - marker.length, head: to - marker.length },
    });
    return true;
  }
  if (text.startsWith(marker) && text.endsWith(endMarker) && text.length > marker.length + endMarker.length) {
    view.dispatch({
      changes: { from, to, insert: text.slice(marker.length, -endMarker.length) },
    });
    return true;
  }
  view.dispatch({
    changes: [
      { from, insert: marker },
      { from: to, insert: endMarker },
    ],
    selection: { anchor: from + marker.length, head: to + marker.length },
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
    if (kind === "bullet" || kind === "number" || kind === "check") {
      const existing = /^\s*(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/.exec(line.text);
      return { from: line.from, to: line.from + (existing?.[0].length ?? 0), insert };
    }
    if (match && !heading) return { from: line.from, to: line.from, insert: "" };
    return { from: line.from, to: line.from + (heading && match ? match[0].length : 0), insert };
  });
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: from === to ? { anchor: changeSet.mapPos(from, 1) } : undefined,
  });
  return true;
}

function continueList(view: EditorView): boolean {
  if (view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  if (view.state.doc.lineAt(to).number !== line.number) return false;
  let node = syntaxTree(view.state).resolveInner(line.from, 1);
  while (node.parent && node.name !== "FencedCode" && node.name !== "CodeBlock") node = node.parent;
  if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
  const match = /^(\s*)(?:(\d+)([.)])\s+|([-*+])\s+)(\[[ xX]\]\s+)?/.exec(line.text);
  if (!match || from < line.from + match[0].length) return false;
  if (!line.text.slice(match[0].length).trim() && from === to) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: match[1] }, selection: { anchor: line.from + match[1].length }, scrollIntoView: true });
    return true;
  }
  const marker = match[2] ? `${Number(match[2]) + 1}${match[3]}` : match[4];
  const insert = `\n${match[1]}${marker} ${match[5] ? "[ ] " : ""}`;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true });
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
