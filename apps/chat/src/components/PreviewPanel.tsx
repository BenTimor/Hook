import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  CircleHelp,
  ExternalLink,
  Flag,
  PanelRightClose,
  RefreshCw,
  X,
} from "lucide-react";

import { api, openExternal } from "../lib/bridge";
import type { PreviewView } from "../lib/types";
import { useChatStore } from "../store/useChatStore";
import {
  ReportContentDialog,
  WorkspacePreview,
  previewDirection,
  reportableFrom,
} from "@hook/chat";

const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 440;
const WIDTH_KEY = "hook.preview.width";
/** Keep in step with the preview-out keyframes. */
const CLOSE_MS = 220;

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
 * most one page open. When the coding-agent run settles the page stays put,
 * the panel stays open and only the automatic refreshing stops.
 */
export function PreviewPanel() {
  const preview = useChatStore((s) => s.preview);
  const open = useChatStore((s) => s.previewOpen);
  const setPreviewOpen = useChatStore((s) => s.setPreviewOpen);

  const [reloads, setReloads] = useState(0);
  const [width, setWidth] = useState(storedWidth);
  const [helpOpen, setHelpOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [rendered, setRendered] = useState(Boolean(preview && open));
  const [closing, setClosing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(
    null,
  );
  // The panel keeps its last page while it animates shut, even if the backend
  // has already announced that the preview is gone.
  const lastPreview = useRef<PreviewView | null>(null);
  if (preview) lastPreview.current = preview;
  const shown = preview ?? lastPreview.current;
  const wantsOpen = Boolean(preview && open);
  const live = Boolean(shown?.live);
  const kind = shown?.kind ?? "page";

  useEffect(() => {
    if (wantsOpen) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    setClosing(true);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(
      () => {
        setRendered(false);
        setClosing(false);
        setHelpOpen(false);
      },
      reduced ? 0 : CLOSE_MS + 20,
    );
    return () => window.clearTimeout(timer);
  }, [wantsOpen, rendered]);

  useEffect(() => {
    if (!live) setHelpOpen(false);
  }, [live]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setHelpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [helpOpen]);

  useEffect(
    () => () => {
      // A pointer can be captured when the panel closes mid-drag.
      delete document.body.dataset.previewDragging;
    },
    [],
  );

  if (!rendered || !shown) return null;

  const waiting = shown.waiting || !shown.url;
  // A data: URL has no query string to bust; appending `?v=` would become part
  // of the rendered page. Remount the iframe instead (the mock preview case).
  const isData = Boolean(shown.url?.startsWith("data:"));
  const src = shown.url
    ? isData
      ? shown.url
      : `${shown.url}${shown.url.includes("?") ? "&" : "?"}v=${shown.version}-${reloads}`
    : "";

  const commitWidth = (next: number) => {
    setWidth(next);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      /* storage is optional */
    }
  };

  // A Workspace preview is other people's words as often as it is the agent's,
  // so it carries its own report action. A page preview is the project itself
  // and has nothing to flag.
  const reportTarget =
    kind === "page"
      ? null
      : reportableFrom({
          kind,
          document: shown.document,
          task: shown.task,
          comments: shown.comments,
          board: shown.board,
          tasks: shown.tasks,
          roadmap: shown.roadmap,
          milestones: shown.milestones,
          brainstorm: shown.brainstorm,
          ideas: shown.ideas,
        });
  const canReport = Boolean(reportTarget && reportTarget.excerpt.trim());

  return (
    <>
      <aside
        className="preview-panel"
        aria-label="Project preview"
        data-closing={closing ? "true" : undefined}
        style={
          {
            width,
            "--preview-width": `${width}px`,
          } as CSSProperties
        }
      >
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
            <div
              className="preview-title"
              title={shown.title}
              // A right-to-left document reads right to left from its title on.
              dir={
                kind === "document" && shown.document && previewDirection(shown.document) === "rtl"
                  ? "rtl"
                  : undefined
              }
            >
              {shown.title ?? "Preview"}
            </div>
            <div
              className="preview-path"
              title={
                kind === "page"
                  ? `${shown.project} / ${shown.file}`
                  : "Hook Workspace"
              }
            >
              {kind === "page"
                ? `${shown.deviceName ? `${shown.deviceName} · ` : ""}${shown.project} / ${shown.file}`
                : "Hook Workspace"}
            </div>
          </div>
          {live && (
            <div className="preview-status">
              <button
                className="preview-live"
                data-open={helpOpen ? "true" : undefined}
                aria-expanded={helpOpen}
                aria-controls={helpOpen ? "preview-note" : undefined}
                title="About this preview"
                onClick={() => setHelpOpen((value) => !value)}
              >
                <span className="preview-live-dot" aria-hidden="true" />
                Live preview
                <CircleHelp strokeWidth={1.8} />
              </button>
            </div>
          )}
          <div className="preview-actions">
            {kind === "page" && (
              <button
                className="icon-btn"
                title="Reload the page"
                onClick={() => setReloads((value) => value + 1)}
              >
                <RefreshCw strokeWidth={1.8} />
              </button>
            )}
            {canReport && reportTarget && (
              <button
                className="icon-btn"
                title={`Report this ${reportTarget.kind}`}
                onClick={() => setReporting(true)}
              >
                <Flag strokeWidth={1.8} />
              </button>
            )}
            {kind === "page" && shown.url && (
              <button
                className="icon-btn"
                title="Open in your browser"
                onClick={() => void openExternal(shown.url!)}
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

        {live && helpOpen && (
          <div className="preview-note" id="preview-note" role="note">
            <div className="preview-note-copy">
              <div className="preview-note-title">A preview, still in progress</div>
              <p className="preview-note-body">
                This is a preview of your project while the agent works on it. It
                is still a work in progress, so the page can change and reload by
                itself as the work continues. When the work is done, the panel
                stays open and you can refresh it yourself.
              </p>
            </div>
            <button
              className="icon-btn preview-note-close"
              title="Got it"
              aria-label="Close explanation"
              onClick={() => setHelpOpen(false)}
            >
              <X strokeWidth={1.9} />
            </button>
          </div>
        )}

        <div className="preview-body" data-kind={kind}>
          {kind !== "page" ? (
            <WorkspacePreview
              body={{
                kind,
                document: shown.document,
                task: shown.task,
                comments: shown.comments,
                board: shown.board,
                tasks: shown.tasks,
                roadmap: shown.roadmap,
                milestones: shown.milestones,
                brainstorm: shown.brainstorm,
                ideas: shown.ideas,
              }}
            />
          ) : waiting ? (
            <div className="preview-waiting">
              {live && <span className="preview-waiting-dot" aria-hidden="true" />}
              <div className="preview-waiting-title">
                {live ? "Waiting for the page" : "No page was written"}
              </div>
              <div className="preview-waiting-file">{shown.file}</div>
              <p className="preview-waiting-note">
                {live
                  ? "It will appear here the moment the agent writes it, and refresh by itself after that."
                  : "The coding agent finished without creating this page."}
              </p>
            </div>
          ) : (
            <iframe
              key={isData ? `${shown.url}-${shown.version}-${reloads}` : shown.url}
              className="preview-frame"
              title={shown.title ?? "Preview"}
              src={src}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
              referrerPolicy="no-referrer"
            />
          )}
        </div>

        {reporting && reportTarget && (
          <ReportContentDialog
            target={reportTarget}
            onClose={() => setReporting(false)}
            submit={(input) =>
              api.reportContent({
                chatId: shown.chatId,
                target: {
                  kind: reportTarget.kind,
                  id: reportTarget.id,
                  projectId: reportTarget.projectId,
                  title: reportTarget.title,
                },
                reason: input.reason,
                note: input.note,
                content: reportTarget.excerpt,
              })
            }
          />
        )}
      </aside>
    </>
  );
}
