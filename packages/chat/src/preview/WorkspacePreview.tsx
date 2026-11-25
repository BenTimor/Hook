import { DocumentMarkdown, readDocumentMeta } from "@hook/markdown";

import { openExternal } from "../open";
import type {
  PreviewTarget,
  WorkspaceBoard,
  WorkspaceComment,
  WorkspaceDocument,
  WorkspacePreviewBody,
  WorkspaceTask,
} from "./types";

/**
 * A board, a task or a document, drawn from the JSON `workspace_preview`
 * returned. The desktop puts this inside its side panel and the phone inside a
 * sheet, so it owns no frame: no close button, no title bar, no resize handle.
 * The chrome belongs to whoever is presenting it.
 */
export function WorkspacePreview({ body }: { body: WorkspacePreviewBody }) {
  switch (body.kind) {
    case "document":
      return body.document ? <DocumentPreview document={body.document} /> : null;
    case "task":
      return body.task ? (
        <TaskPreview task={body.task} comments={body.comments ?? []} />
      ) : null;
    case "board":
      return body.board ? (
        <BoardPreview board={body.board} tasks={body.tasks ?? []} />
      ) : null;
  }
}

/**
 * The way a document reads: its own `::meta{direction=…}` line, never a field
 * beside the Markdown. The panel's title uses it, and so does the page.
 */
export function previewDirection(document: WorkspaceDocument): "ltr" | "rtl" {
  return readDocumentMeta(document.markdown).direction;
}

export function DocumentPreview({ document }: { document: WorkspaceDocument }) {
  // A page, not a fragment: the same `hook-doc` numbers the Workspace window
  // draws, inside the frame a document gets there.
  return (
    <div className="preview-doc" data-preview-entity="document" data-id={document.id}>
      <DocumentMarkdown
        markdown={document.markdown}
        className="preview-doc-page"
        onOpen={(url) => void openExternal(url)}
      />
    </div>
  );
}

export function TaskPreview({
  task,
  comments,
}: {
  task: WorkspaceTask;
  comments: WorkspaceComment[];
}) {
  return (
    <div
      className="preview-entity"
      data-preview-entity="task"
      data-id={task.id}
    >
      <h2 className="preview-entity-title">{task.title}</h2>
      {task.description ? <DocumentMarkdown markdown={task.description} onOpen={(url) => void openExternal(url)} /> : null}
      {comments.length > 0 && (
        <div className="preview-comments">
          <div className="preview-comments-title">Comments</div>
          {comments.map((comment) => (
            <div
              className="preview-comment"
              key={comment.id}
              data-comment-id={comment.id}
            >
              <div className="preview-comment-meta">
                <span>{comment.author}</span>
                {comment.authorKind === "agent" && (
                  <span className="preview-agent-tag">via Hook agent</span>
                )}
              </div>
              <DocumentMarkdown markdown={comment.body} onOpen={(url) => void openExternal(url)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BoardPreview({
  board,
  tasks,
}: {
  board: WorkspaceBoard;
  tasks: WorkspaceTask[];
}) {
  const status = board.columns.find((column) => column.type === "status");
  const columns = status?.options ?? [];
  return (
    <div
      className="preview-entity"
      data-preview-entity="board"
      data-id={board.id}
    >
      <h2 className="preview-entity-title">{board.name}</h2>
      {board.description ? (
        <p className="preview-entity-note">{board.description}</p>
      ) : null}
      <div className="preview-board">
        {columns.map((column) => {
          const items = tasks.filter((task) => task.status === column.id);
          return (
            <div className="preview-board-column" key={column.id}>
              <div className="preview-board-head">
                {column.label}
                <span>{items.length}</span>
              </div>
              {items.map((task) => (
                <div className="preview-board-card" key={task.id}>
                  {task.title}
                </div>
              ))}
              {items.length === 0 && (
                <div className="preview-board-empty">Nothing here</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What a preview would report, if the person asks to.
 *
 * A task's comments are written by other people — that is user-generated
 * content, not model output, and both stores require a way to flag it. The
 * excerpt is the words themselves, never the whole project: a reviewer needs
 * to see what was offensive, not the account.
 */
export function reportableFrom(body: WorkspacePreviewBody): PreviewTarget | null {
  switch (body.kind) {
    case "document":
      return body.document
        ? {
            kind: "document",
            id: body.document.id,
            projectId: body.document.projectId,
            title: body.document.title,
            excerpt: body.document.markdown,
          }
        : null;
    case "task": {
      if (!body.task) return null;
      const comments = (body.comments ?? [])
        .map((comment) => `${comment.author}:\n${comment.body}`)
        .join("\n\n");
      const task = body.task;
      return {
        kind: "task",
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        excerpt: [task.description, comments].filter(Boolean).join("\n\n"),
      };
    }
    case "board":
      return body.board
        ? {
            kind: "board",
            id: body.board.id,
            projectId: body.board.projectId,
            title: body.board.name,
            excerpt: (body.tasks ?? []).map((task) => task.title).join("\n"),
          }
        : null;
  }
}
