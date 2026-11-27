import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ChatAttachment } from "./types";

export interface LightboxProps {
  attachments: ChatAttachment[];
  urls: Record<string, string>;
  startIndex: number;
  onClose: () => void;
  /**
   * Hand the picture to the OS. Both hooks are optional: a phone has nothing
   * to "open in your image viewer", so those buttons simply are not drawn.
   */
  onOpen?: (attachment: ChatAttachment) => Promise<void>;
  /** A copy in a folder the user will find, with no dialog. Answers the path. */
  onSave?: (attachment: ChatAttachment) => Promise<string>;
  /** Save a copy and report the chosen name, or null if the dialog was closed. */
  onSaveAs?: (attachment: ChatAttachment, suggestedName: string) => Promise<string | null>;
}

function sizeLabel(bytes: number) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A friendly default name for "Save as…"; the backend adds the extension. */
function suggestedName(attachment: ChatAttachment, index: number) {
  const stem = attachment.kind === "screenshot" ? "screenshot" : "hook-image";
  return index === 0 ? stem : `${stem}-${index + 1}`;
}

/**
 * The picture as a PNG blob, for the clipboard.
 *
 * The clipboard takes PNG (a JPEG or a WebP is not a picture it will hold), so
 * anything else is drawn onto a canvas first. The size does not change: the
 * browser keeps the bytes the reader can see.
 */
async function toPngBlob(source: string): Promise<Blob> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.drawImage(image, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no blob"))), "image/png");
  });
}

/**
 * Big view of a picture. Shows one attachment at a time, lets the reader copy
 * the picture, save it, save a copy somewhere else, or blow it up to the whole
 * window.
 *
 * It is the same component in the chat window and on a phone; the only thing a
 * product supplies is what "open" and "save" mean, and on a phone they mean
 * nothing at all.
 *
 * It is drawn in a portal on `document.body`, because the conversation owns
 * stacking contexts of its own: a fixed overlay inside a message was painted
 * under the composer and the checklist at the bottom of the chat.
 */
export function Lightbox({
  attachments,
  urls,
  startIndex,
  onClose,
  onOpen,
  onSave,
  onSaveAs,
}: LightboxProps) {
  const [index, setIndex] = useState(startIndex);
  const [full, setFull] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const noteTimer = useRef<number | null>(null);

  const current = attachments[index];
  const url = current ? urls[current.id] ?? "" : "";
  const many = attachments.length > 1;
  // Full-page captures are metres tall: fit their width and let the frame
  // scroll, instead of shrinking them to an unreadable sliver.
  const tall = current ? current.height > current.width * 1.6 : false;

  const flash = useCallback((text: string) => {
    setNote(text);
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    // A path is a sentence, not a status: leave it up long enough to read.
    const shown = text.length > 24 ? 6000 : 2600;
    noteTimer.current = window.setTimeout(() => setNote(null), shown);
  }, []);

  useEffect(() => () => {
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
  }, []);

  // Take focus so the keyboard belongs to the picture, and give it back after.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  // A new picture starts at its top.
  useEffect(() => {
    frameRef.current?.scrollTo({ top: 0 });
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // Capture phase: the app's own Esc (stop the reply) must not fire.
        event.stopImmediatePropagation();
        if (full) setFull(false);
        else onClose();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!many) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const step = event.key === "ArrowRight" ? 1 : -1;
      setIndex((value) => Math.min(attachments.length - 1, Math.max(0, value + step)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [attachments.length, full, many, onClose]);

  const open = async () => {
    if (!current || !onOpen) return;
    try {
      await onOpen(current);
    } catch {
      flash("Couldn't open it");
    }
  };

  const copy = async () => {
    if (!current || !url) return;
    try {
      const blob = await toPngBlob(url);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash("Copied");
    } catch {
      flash("Couldn't copy it");
    }
  };

  const save = async (ask: boolean) => {
    if (!current || saving) return;
    if (ask ? !onSaveAs : !onSave) return;
    setSaving(true);
    try {
      if (ask) {
        const saved = await onSaveAs!(current, suggestedName(current, index));
        if (saved) flash("Saved");
      } else {
        const path = await onSave!(current);
        flash(`Saved to ${path}`);
      }
    } catch {
      flash("Couldn't save it");
    } finally {
      setSaving(false);
    }
  };

  if (!current) return null;

  const meta = [
    current.width && current.height ? `${current.width}×${current.height}` : "",
    sizeLabel(current.bytes),
    many ? `${index + 1} / ${attachments.length}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return createPortal(
    <div
      className="lightbox"
      data-full={full || undefined}
      role="dialog"
      aria-modal="true"
      aria-label="Picture"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lightbox-panel">
        <div
          className="lightbox-frame"
          ref={frameRef}
          data-tall={tall || undefined}
          onDoubleClick={() => setFull((value) => !value)}
        >
          {url ? (
            <img
              src={url}
              alt={
                current.kind === "screenshot"
                  ? "Screenshot from the coding agent"
                  : current.kind === "generated"
                    ? "Picture Hook made"
                    : "Attached picture"
              }
              draggable={false}
            />
          ) : (
            <span className="lightbox-loading" />
          )}
        </div>
      </div>

      {many && (
        <>
          <button
            className="lightbox-nav"
            data-side="left"
            type="button"
            disabled={index === 0}
            aria-label="Previous picture"
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            ‹
          </button>
          <button
            className="lightbox-nav"
            data-side="right"
            type="button"
            disabled={index === attachments.length - 1}
            aria-label="Next picture"
            onClick={() => setIndex((value) => Math.min(attachments.length - 1, value + 1))}
          >
            ›
          </button>
        </>
      )}

      <div className="lightbox-bar">
        <button
          type="button"
          className="lightbox-action"
          onClick={() => void copy()}
          disabled={!url}
        >
          Copy picture
        </button>
        {onSave ? (
          <button
            type="button"
            className="lightbox-action"
            onClick={() => void save(false)}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        ) : null}
        {onSaveAs ? (
          <button
            type="button"
            className="lightbox-action"
            onClick={() => void save(true)}
            disabled={saving}
          >
            Save as…
          </button>
        ) : null}
        {onOpen ? (
          <button type="button" className="lightbox-action" onClick={open}>
            Open
          </button>
        ) : null}
        <button
          type="button"
          className="lightbox-action"
          onClick={() => setFull((value) => !value)}
        >
          {full ? "Exit full screen" : "Full screen"}
        </button>
        {note ? (
          <span className="lightbox-note" role="status">
            {note}
          </span>
        ) : (
          meta && <span className="lightbox-meta">{meta}</span>
        )}
      </div>

      <button
        className="lightbox-close"
        type="button"
        aria-label="Close"
        ref={closeRef}
        onClick={onClose}
      >
        ✕
      </button>
    </div>,
    document.body,
  );
}
