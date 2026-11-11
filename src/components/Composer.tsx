import { useEffect, useRef, useState } from "react";
import { ArrowUp, CornerDownLeft, ImagePlus, Square, X } from "lucide-react";

import { useChatStore } from "../store/useChatStore";
import type { DraftImage } from "../lib/types";
import { useSteering } from "../lib/agents";

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

export function Composer() {
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const activeId = useChatStore((s) => s.activeId);
  const streaming = useChatStore((s) => (s.activeId ? Boolean(s.streams[s.activeId]) : false));
  const ready = useChatStore((s) => s.ready);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const focusToken = useChatStore((s) => s.focusToken);
  const draftImages = useChatStore((s) => s.draftImages);
  const addDraftImages = useChatStore((s) => s.addDraftImages);
  const removeDraftImage = useChatStore((s) => s.removeDraftImage);
  // While an agent works, the composer is mostly a steering wheel: the chat
  // agent hands what you type to the coding agent instead of starting new work.
  const steering = useSteering();

  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [composing, setComposing] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);

  useEffect(() => {
    if (focusToken > 0) ref.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    ref.current?.focus();
  }, [activeId]);

  const stage = async (files: FileList | File[] | null) => {
    if (!files) return;
    const images = await Promise.all(Array.from(files).map(fileToDraftImage));
    const usable = images.filter((image): image is DraftImage => image !== null);
    if (usable.length) addDraftImages(usable);
  };

  const submit = () => {
    const text = draft.trim();
    if ((!text && draftImages.length === 0) || !ready || streaming) return;
    void send(text);
    if (ref.current) ref.current.style.height = "auto";
  };

  const canSend = (draft.trim().length > 0 || draftImages.length > 0) && ready;

  return (
    <div
      className="composer-wrap"
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
        {draftImages.length > 0 && (
          <div className="composer-images">
            {draftImages.map((image) => (
              <figure className="composer-image" key={image.id}>
                <img src={image.dataUrl} alt="" />
                <button
                  className="composer-image-x"
                  title="Remove"
                  aria-label="Remove image"
                  onClick={() => removeDraftImage(image.id)}
                >
                  <X strokeWidth={2.6} />
                </button>
              </figure>
            ))}
          </div>
        )}
        <div className="composer-row">
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
          <textarea
            ref={ref}
            rows={1}
            value={draft}
            spellCheck={false}
            placeholder={steering ? "Steer the agent…" : "Ask anything…"}
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onPaste={(event) => {
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
          {streaming ? (
            <button
              className="send-btn"
              data-stop="true"
              title="Stop generating"
              aria-label="Stop generating"
              onClick={() => void stop()}
            >
              <Square strokeWidth={2.4} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-btn"
              title={steering ? "Send to the working agent" : "Send"}
              aria-label={steering ? "Send to the working agent" : "Send"}
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUp strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint" data-active={canSend || steering}>
        {steering ? (
          <>Enter to send · your message steers the working agent</>
        ) : (
          <>
            <CornerDownLeft size={10} style={{ display: "inline", verticalAlign: "-1px" }} /> Enter to
            send · Shift + Enter for a new line
          </>
        )}
      </div>
    </div>
  );
}
