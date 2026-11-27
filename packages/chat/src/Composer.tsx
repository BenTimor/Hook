import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, CornerDownLeft, ImagePlus, Plus, Square, X } from "lucide-react";

import type { DraftImage, SlashCommand } from "./types";
import "./chat.css";

/** Downscale before sending: a 6 MP phone photo is not worth 8 MB of base64. */
const MAX_EDGE = 1600;

/** How long the command menu stays mounted after it closes (`chat.css`). */
const MENU_EXIT_MS = 90;

export async function fileToDraftImage(file: File): Promise<DraftImage | null> {
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
  /**
   * While a job is running, Send still works and steers it; Stop sits beside it.
   * A coding-agent conversation is a conversation even mid-run.
   */
  steer?: boolean;
  /** The account and the chat are ready; before that the composer is inert. */
  ready?: boolean;
  images?: DraftImage[];
  /** Omit to hide the attach button — a dock without picture support must not offer it. */
  onAddImages?: (images: DraftImage[]) => void;
  onRemoveImage?: (id: string) => void;
  /** A host-owned attachment menu; replaces the built-in image picker button. */
  onAttach?: () => void;
  /**
   * Enter sends and Shift + Enter breaks the line — the desktop gesture. A
   * phone turns it off: it has no Shift key, so Enter has to insert a line and
   * the send button is the only way to send. Ctrl/⌘ + Enter sends either way,
   * for a keyboard attached to a phone.
   */
  enterSends?: boolean;
  placeholder?: string;
  /** The line under the box. Products use it to explain what Enter will do.
      `null` hides it entirely. */
  hint?: ReactNode | null;
  /** Change it to move the caret here (a new chat, a new conversation). */
  focusKey?: string | number | null;
  /**
   * Take focus when the composer mounts. The desktop window opens ready to
   * type; a phone stays compact until the field is tapped.
   */
  autoFocus?: boolean;
  /**
   * The textarea gained or lost focus. A phone uses it to open the composer
   * into a writing surface; the window and the dock have room either way.
   */
  onFocusChange?: (focused: boolean) => void;
  /**
   * Commands the composer offers when the draft starts with `/`. Empty or
   * omitted means no menu — the backend only hands them to advanced mode, so a
   * product never has to decide which mode it is in.
   */
  commands?: SlashCommand[];
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
  steer = false,
  ready = true,
  images = [],
  onAddImages,
  onRemoveImage,
  onAttach,
  placeholder = "Ask anything…",
  hint,
  focusKey,
  enterSends = true,
  autoFocus = false,
  onFocusChange,
  commands = [],
  className,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [composing, setComposing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  // The menu is open while the draft is a command name being typed. Escape
  // closes it for that exact text, so typing on opens it again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // Mounted a beat longer than it is open, so the close animation can play.
  // What was on screen is kept for that beat: the matches are gone by then.
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const lastMatches = useRef<SlashCommand[]>([]);

  const query = /^\/[^\s]*$/.test(value) ? value.slice(1).toLowerCase() : null;
  const matches = query === null ? [] : commands.filter((c) => c.name.startsWith(query));
  const menuOpen = matches.length > 0 && dismissed !== value;
  const shown = menuOpen ? matches : lastMatches.current;

  useEffect(() => {
    if (menuOpen) lastMatches.current = matches;
  }, [menuOpen, matches]);

  useEffect(() => {
    if (menuOpen) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    // A timeout rather than `animationend`: with reduced motion the animation
    // never runs, and the node still has to go.
    const timer = window.setTimeout(() => {
      setClosing(false);
      setMounted(false);
    }, MENU_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [menuOpen, mounted]);

  const pick = (command: SlashCommand) => {
    onChange(`/${command.name} `);
    setDismissed(null);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  // Grow to fit what was typed, up to the cap the stylesheet also sets.
  //
  // Two conditions, both learned the hard way: an element that has not been
  // laid out yet reports a zero width, and a zero-width box wraps "Ask
  // anything…" one character per line, so `scrollHeight` measures hundreds of
  // pixels and the composer opens tall (the browser's side panel does this while
  // it is being attached). And a box that changes width — a panel sliding open,
  // a window resizing, the phone's keyboard closing — has to be measured again,
  // or it keeps the height it had at the old width.
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || !el.clientWidth) return;
    // Measure the text, not the box: a phone lifts the composer with a CSS
    // `min-height` while it is focused, and `scrollHeight` would report that
    // lifted height as the content, leaving an empty composer tall after blur.
    const min = el.style.minHeight;
    el.style.minHeight = "0";
    el.style.height = "auto";
    const height = Math.min(el.scrollHeight, 260);
    el.style.minHeight = min;
    el.style.height = `${height}px`;
  }, []);

  useEffect(() => {
    fit();
  }, [value, fit]);

  // The phone changes the field's padding between the compact bar and the
  // focused surface. Re-measure once the blur transition has settled, or a
  // multi-line draft would keep the height its focused padding needed.
  useEffect(() => {
    if (focused) {
      fit();
      return;
    }
    const timer = window.setTimeout(fit, 240);
    return () => window.clearTimeout(timer);
  }, [focused, fit]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = Math.round(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      // Width only: the height is what this writes, and watching it would be a
      // loop rather than a measurement.
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next === width) return;
      width = next;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  // The key the field was born with. StrictMode runs a mount effect twice, so
  // a "first run" flag is not enough; comparing the key is.
  const mountKey = useRef(focusKey);
  useEffect(() => {
    // Mounting is not a reason to take focus on a phone: it would open the
    // writing surface (and the keyboard's space) before anyone asked.
    if (!autoFocus && focusKey === mountKey.current) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    // A staged prompt is meant to be continued: the caret goes after it, not
    // to the start of the line where the pointer would put it.
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [focusKey, autoFocus]);

  const stage = async (files: FileList | File[] | null) => {
    if (!files || !onAddImages) return;
    const pictures = await Promise.all(Array.from(files).map(fileToDraftImage));
    const usable = pictures.filter((image): image is DraftImage => image !== null);
    if (usable.length) onAddImages(usable);
  };

  const submit = () => {
    const text = value.trim();
    if ((!text && images.length === 0) || !ready) return;
    if (busy && !steer) return;
    onSend();
    if (ref.current) ref.current.style.height = "auto";
  };

  const canSend = (value.trim().length > 0 || images.length > 0) && ready;

  return (
    <div
      className={className ? `composer-wrap ${className}` : "composer-wrap"}
      data-focused={focused || undefined}
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
        {mounted && shown.length > 0 ? (
          <div
            className="composer-menu"
            role="listbox"
            aria-label="Commands"
            data-closing={closing || undefined}
          >
            {shown.map((command, index) => (
              <button
                type="button"
                key={command.name}
                className="composer-menu-item"
                role="option"
                aria-selected={index === active}
                data-active={index === active || undefined}
                onMouseEnter={() => setActive(index)}
                // mousedown, not click: the textarea must keep the focus.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(command);
                }}
              >
                <span className="composer-menu-usage">{command.usage}</span>
                <span className="composer-menu-summary">{command.summary}</span>
              </button>
            ))}
          </div>
        ) : null}
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
                title={onAttach ? "Add to chat" : "Attach a picture"}
                aria-label={onAttach ? "Add to chat" : "Attach a picture"}
                disabled={!ready}
                onClick={() => (onAttach ? onAttach() : fileInput.current?.click())}
              >
                {onAttach ? <Plus strokeWidth={2} /> : <ImagePlus strokeWidth={1.9} />}
              </button>
              {onAttach ? null : (
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
              )}
            </>
          )}
          <textarea
            ref={ref}
            dir="auto"
            rows={1}
            value={value}
            spellCheck={false}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onFocus={() => {
              setFocused(true);
              onFocusChange?.(true);
            }}
            onBlur={() => {
              setFocused(false);
              onFocusChange?.(false);
            }}
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
              if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((index) => (index + step + matches.length) % matches.length);
                return;
              }
              if (menuOpen && event.key === "Escape") {
                // Escape closes the menu for this draft and must not also reach
                // the window, where the same key stops the running turn.
                event.stopPropagation();
                setDismissed(value);
                return;
              }
              if (
                menuOpen &&
                (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !composing))
              ) {
                // Enter completes the command; the next Enter sends it.
                event.preventDefault();
                pick(matches[Math.min(active, matches.length - 1)]);
                return;
              }
              if (event.key === "Enter" && !composing) {
                const go = event.ctrlKey || event.metaKey;
                // A phone keeps the line: Enter is a new line there, and the
                // send button is the only thing that sends.
                if (enterSends ? event.shiftKey : !go) return;
                event.preventDefault();
                submit();
              }
            }}
          />
          {busy && steer && (
            <button
              className="send-btn"
              data-stop="true"
              title="Stop the agent"
              aria-label="Stop the agent"
              onClick={onStop}
            >
              <Square strokeWidth={2.4} fill="currentColor" />
            </button>
          )}
          {busy && !steer ? (
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
              title={busy ? "Steer the agent" : "Send"}
              aria-label={busy ? "Steer the agent" : "Send"}
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUp strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
      {hint !== null ? (
        <div className="composer-hint" data-active={canSend}>
          {hint ?? (
            <>
              <CornerDownLeft
                size={10}
                style={{ display: "inline", verticalAlign: "-1px" }}
              />{" "}
              Enter to send · Shift + Enter for a new line
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
