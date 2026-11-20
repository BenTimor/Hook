import { useEffect, useState } from "react";
import { Flag, X } from "lucide-react";

import {
  ReportContentDialog,
  WorkspacePreview,
  reportableFrom,
  type WorkspacePreviewBody,
} from "@hook/chat";

import { mobile } from "../lib/api";
import { useMobileChat } from "../store/useMobileChat";

/**
 * The preview, as a sheet.
 *
 * The desktop gives a Workspace board a 440px column beside the chat; a phone
 * has nowhere to put that column, so the same renderer comes up from the
 * bottom over the conversation and can be dismissed by swiping it away. What
 * it draws is identical — `WorkspacePreview` takes the JSON `workspace_preview`
 * returned and owns no frame.
 */
export function PreviewSheet() {
  const preview = useMobileChat((s) => s.preview);
  const open = useMobileChat((s) => s.previewOpen);
  const setOpen = useMobileChat((s) => s.setPreviewOpen);
  const [reporting, setReporting] = useState(false);

  // A phone's back gesture closes the sheet before it closes the chat.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!preview?.active || !open) return null;

  const body: WorkspacePreviewBody = {
    kind: preview.kind ?? "board",
    document: preview.document,
    task: preview.task,
    comments: preview.comments,
    board: preview.board,
    tasks: preview.tasks,
  };
  const reportTarget = reportableFrom(body);
  const canReport = Boolean(reportTarget && reportTarget.excerpt.trim());

  return (
    <div className="sheet-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={preview.title ?? "Preview"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <div className="sheet-heading">
            <div className="sheet-title">{preview.title ?? "Preview"}</div>
            <div className="sheet-note">Hook Workspace</div>
          </div>
          {canReport && reportTarget ? (
            <button
              className="icon-btn"
              title={`Report this ${reportTarget.kind}`}
              onClick={() => setReporting(true)}
            >
              <Flag strokeWidth={1.8} />
            </button>
          ) : null}
          <button className="icon-btn" title="Close" onClick={() => setOpen(false)}>
            <X strokeWidth={2} />
          </button>
        </header>

        <div className="sheet-body">
          <WorkspacePreview body={body} />
        </div>

        {reporting && reportTarget ? (
          <ReportContentDialog
            target={reportTarget}
            onClose={() => setReporting(false)}
            submit={(input) =>
              mobile.reportContent({
                chatId: preview.chatId,
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
        ) : null}
      </div>
    </div>
  );
}
