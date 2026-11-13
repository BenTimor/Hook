import { useEffect, useRef, useState } from "react";
import { ExternalLink, PanelRightClose, RefreshCw } from "lucide-react";

import { openExternal } from "../lib/bridge";
import { useChatStore } from "../store/useChatStore";

const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 440;
const WIDTH_KEY = "hook.preview.width";

function clampWidth(width: number): number {
  const ceiling = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth * 0.62));
  return Math.round(Math.min(ceiling, Math.max(MIN_WIDTH, width)));
}

function storedWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    const value = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(value)) return clampWidth(value);
  } catch {
    /* private mode, or a browser with no storage */
  }
  return clampWidth(DEFAULT_WIDTH);
}

/**
 * The right-side preview. One HTML page, served from the project over a
 * loopback server by the Rust side, reloaded whenever the project changes.
 * It is a sidecar of the app rather than of one chat: the backend keeps at
 * most one page open and closes it when the coding-agent run that set it
 * settles.
 */
export function PreviewPanel() {
  const preview = useChatStore((s) => s.preview);
  const open = useChatStore((s) => s.previewOpen);
  const setPreviewOpen = useChatStore((s) => s.setPreviewOpen);

  const [reloads, setReloads] = useState(0);
  const [width, setWidth] = useState(storedWidth);
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(
    null,
  );

  useEffect(
    () => () => {
      // A pointer can be captured when the panel closes mid-drag.
      delete document.body.dataset.previewDragging;
    },
    [],
  );

  if (!preview || !open) return null;

  const waiting = preview.waiting || !preview.url;
  const src = preview.url
    ? `${preview.url}${preview.url.includes("?") ? "&" : "?"}v=${preview.version}-${reloads}`
    : "";

  const commitWidth = (next: number) => {
    setWidth(next);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      /* storage is optional */
    }
  };

  return (
    <aside className="preview-panel" style={{ width }}>
      <div
        className="preview-resize"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startX: event.clientX, startWidth: width, width };
          document.body.dataset.previewDragging = "true";
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const next = clampWidth(
            drag.current.startWidth + (drag.current.startX - event.clientX),
          );
          drag.current.width = next;
          setWidth(next);
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          const next = drag.current.width;
          drag.current = null;
          delete document.body.dataset.previewDragging;
          commitWidth(next);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          delete document.body.dataset.previewDragging;
        }}
      />

      <div className="preview-head" data-tauri-drag-region>
        <div className="preview-heading" data-tauri-drag-region>
          <div className="preview-title" title={preview.title}>
            {preview.title ?? "Preview"}
          </div>
          <div className="preview-path" title={`${preview.project} / ${preview.file}`}>
            {preview.project} / {preview.file}
          </div>
        </div>
        <div className="preview-actions">
          <button
            className="icon-btn"
            title="Reload the page"
            onClick={() => setReloads((value) => value + 1)}
          >
            <RefreshCw strokeWidth={1.8} />
          </button>
          {preview.url && (
            <button
              className="icon-btn"
              title="Open in your browser"
              onClick={() => void openExternal(preview.url!)}
            >
              <ExternalLink strokeWidth={1.8} />
            </button>
          )}
          <button
            className="icon-btn"
            title="Hide preview"
            onClick={() => setPreviewOpen(false)}
          >
            <PanelRightClose strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="preview-body">
        {waiting ? (
          <div className="preview-waiting">
            <span className="preview-waiting-dot" aria-hidden="true" />
            <div className="preview-waiting-title">Waiting for the page</div>
            <div className="preview-waiting-file">{preview.file}</div>
            <p className="preview-waiting-note">
              It will appear here the moment the agent writes it, and refresh
              by itself after that.
            </p>
          </div>
        ) : (
          <iframe
            key={preview.url}
            className="preview-frame"
            title={preview.title ?? "Preview"}
            src={src}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </aside>
  );
}
