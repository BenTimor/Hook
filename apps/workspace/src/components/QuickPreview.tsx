import { useEffect, useRef, useState } from "react";
import { FileText, KanbanSquare } from "lucide-react";
import { DocumentMarkdown } from "@hook/markdown";

import { api } from "../lib/bridge";
import type { Task } from "../lib/types";

/** Load real content only when a tile comes into view; never change the open item. */
export function QuickPreview({
  kind,
  id,
  updatedAt,
}: {
  kind: "board" | "document";
  id: string;
  updatedAt: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [content, setContent] = useState<{
    text?: string;
    tasks?: Task[];
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!element.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setContent(null);
    setFailed(false);
    const request =
      kind === "board"
        ? api.tasks(id).then((result) => ({ tasks: result.tasks }))
        : api
            .document(id)
            .then((result) => ({ text: result.document.markdown ?? "" }));
    void request
      .then((result) => {
        if (active) setContent(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [visible, kind, id, updatedAt]);

  return (
    <div className="ws-quick-preview" ref={element} aria-hidden="true">
      {failed ? (
        <span className="ws-preview-placeholder">Preview unavailable</span>
      ) : !content ? (
        <span className="ws-preview-placeholder">
          {kind === "board" ? <KanbanSquare /> : <FileText />} Loading preview…
        </span>
      ) : kind === "board" ? (
        <div className="ws-preview-board">
          <div className="ws-preview-board-head">Task</div>
          {(content.tasks ?? []).length === 0 ? (
            <span className="ws-preview-placeholder ws-preview-empty">No tasks yet</span>
          ) : (
            (content.tasks ?? []).slice(0, 3).map((task) => (
              <div className="ws-preview-task" key={task.id}>
                <span className="ws-preview-task-title">{task.title}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        // The tile's direction is the document's own `::meta` line.
        <div className="ws-preview-document">
          {content.text?.trim() ? (
            <DocumentMarkdown markdown={content.text} className="ws-quick-preview-md" />
          ) : <span className="ws-preview-placeholder">Empty document</span>}
        </div>
      )}
    </div>
  );
}
