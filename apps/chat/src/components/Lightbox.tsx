import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/bridge";
import type { Attachment } from "../lib/types";

type Props = {
  chatId: string | null;
  attachments: Attachment[];
  urls: Record<string, string>;
  startIndex: number;
  onClose: () => void;
};

function sizeLabel(bytes: number) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A friendly default name for "Save as…"; the backend adds the extension. */
function suggestedName(attachment: Attachment, index: number) {
  const stem = attachment.kind === "screenshot" ? "screenshot" : "hook-image";
  return index === 0 ? stem : `${stem}-${index + 1}`;
}

/**
 * Big view of a picture. Shows one attachment at a time, lets the reader open
 * it in their own image viewer, save a copy wherever they like, or blow it up
 * to the whole window.
 */
export function Lightbox({ chatId, attachments, urls, startIndex, onClose }: Props) {
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
    noteTimer.current = window.setTimeout(() => setNote(null), 2600);
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
    if (!chatId || !current) return;
    try {
      await api.openImage(chatId, current.id);
    } catch {
      flash("Couldn't open it");
    }
  };

  const save = async () => {
    if (!chatId || !current || saving) return;
    setSaving(true);
    try {
      const saved = await api.saveImageAs(chatId, current.id, suggestedName(current, index));
      if (saved) flash("Saved");
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

  return (
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
              alt={current.kind === "screenshot" ? "Screenshot from the coding agent" : "Attached picture"}
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
        <button type="button" className="lightbox-action" onClick={open}>
          Open
        </button>
        <button type="button" className="lightbox-action" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save as…"}
        </button>
        <button type="button" className="lightbox-action" onClick={() => setFull((value) => !value)}>
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
    </div>
  );
}
