import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, CornerDownLeft, ImagePlus, Square, X } from "lucide-react";

import type { DraftImage } from "./types";
import "./chat.css";

/** Downscale before sending: a 6 MP phone photo is not worth 8 MB of base64. */
const MAX_EDGE = 1600;

async function fileToDraftImage(file: File): Promise<DraftImage | null> {
  if (!file.type.startsWith("image/")) return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Screenshots stay lossless; photos become JPEG (much smaller).
  const lossless = file.type === "image/png" || file.type === "image/gif";
  const dataUrl = canvas.toDataURL(lossless ? "image/png" : "image/jpeg", 0.88);
  return { id: crypto.randomUUID(), dataUrl, width, height };
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  /** A reply is arriving: the send button becomes Stop. */
  busy?: boolean;
  /** The account and the chat are ready; before that the composer is inert. */
  ready?: boolean;
  images?: DraftImage[];
  /** Omit to hide the attach button — a dock without picture support must not offer it. */
  onAddImages?: (images: DraftImage[]) => void;
  onRemoveImage?: (id: string) => void;
  placeholder?: string;
  /** The line under the box. Products use it to explain what Enter will do. */
  hint?: ReactNode;
  /** Change it to move the caret here (a new chat, a new conversation). */
  focusKey?: string | number | null;
  className?: string;
}

/**
 * The input. Paste or drop a picture, type, Enter sends, Shift + Enter breaks
 * the line — the same gestures in the chat window and in a product's dock.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  ready = true,
  images = [],
  onAddImages,
  onRemoveImage,
  placeholder = "Ask anything…",
  hint,
  focusKey,
  className,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [composing, setComposing] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [value]);

  useEffect(() => {
    ref.current?.focus();
  }, [focusKey]);

  const stage = async (files: FileList | File[] | null) => {
    if (!files || !onAddImages) return;
    const pictures = await Promise.all(Array.from(files).map(fileToDraftImage));
    const usable = pictures.filter((image): image is DraftImage => image !== null);
    if (usable.length) onAddImages(usable);
  };

  const submit = () => {
    const text = value.trim();
    if ((!text && images.length === 0) || !ready || busy) return;
    onSend();
    if (ref.current) ref.current.style.height = "auto";
  };

  const canSend = (value.trim().length > 0 || images.length > 0) && ready;

  return (
    <div
      className={className ? `composer-wrap ${className}` : "composer-wrap"}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void stage(event.dataTransfer.files);
      }}
    >
      <div className="composer" data-dragging={dragging || undefined}>
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((image) => (
              <figure className="composer-image" key={image.id}>
                <img src={image.dataUrl} alt="" />
                <button
                  className="composer-image-x"
                  title="Remove"
                  aria-label="Remove image"
                  onClick={() => onRemoveImage?.(image.id)}
                >
                  <X strokeWidth={2.6} />
                </button>
              </figure>
            ))}
          </div>
        )}
        <div className="composer-row">
          {onAddImages && (
            <>
              <button
                className="attach-btn"
                title="Attach a picture"
                aria-label="Attach a picture"
                disabled={!ready}
                onClick={() => fileInput.current?.click()}
              >
                <ImagePlus strokeWidth={1.9} />
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                onChange={(event) => {
                  void stage(event.target.files);
                  event.target.value = "";
                }}
              />
            </>
          )}
          <textarea
            ref={ref}
            rows={1}
            value={value}
            spellCheck={false}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onPaste={(event) => {
              if (!onAddImages) return;
              const files = Array.from(event.clipboardData.files);
              if (files.length && files.every((file) => file.type.startsWith("image/"))) {
                event.preventDefault();
                void stage(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !composing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button
              className="send-btn"
              data-stop="true"
              title="Stop generating"
              aria-label="Stop generating"
              onClick={onStop}
            >
              <Square strokeWidth={2.4} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-btn"
              title="Send"
              aria-label="Send"
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUp strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      {hint ? (
        <div className="composer-hint" data-active={canSend}>
          {hint}
        </div>
      ) : (
        <div className="composer-hint" data-active={canSend}>
          <CornerDownLeft size={10} style={{ display: "inline", verticalAlign: "-1px" }} /> Enter to
          send · Shift + Enter for a new line
        </div>
      )}
    </div>
  );
}
