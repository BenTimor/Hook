import type { CSSProperties } from "react";
import { Lightbulb } from "lucide-react";

import { DocumentMarkdown, readDocumentMeta } from "@hook/markdown";

import { openExternal } from "../open";
import type {
  PreviewTarget,
  WorkspaceBoard,
  WorkspaceBrainstorm,
  WorkspaceBrainstormIdea,
  WorkspaceComment,
  WorkspaceDocument,
  WorkspaceMilestone,
  WorkspacePreviewBody,
  WorkspaceRoadmap,
  WorkspaceTask,
} from "./types";

/**
 * A board, a task, a document, a roadmap or a brainstorm, drawn from the JSON `workspace_preview`
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
    case "roadmap":
      return body.roadmap ? (
        <RoadmapPreview
          roadmap={body.roadmap}
          milestones={body.milestones ?? []}
        />
      ) : null;
    case "brainstorm":
      return body.brainstorm ? (
        <BrainstormPreview
          brainstorm={body.brainstorm}
          ideas={body.ideas ?? []}
        />
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

const MILESTONE_STATUS: Record<
  WorkspaceMilestone["status"],
  { label: string }
> = {
  planned: { label: "Planned" },
  active: { label: "In progress" },
  done: { label: "Done" },
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function milestoneDate(value: string | null): string {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  const monthName = MONTHS[Number(month) - 1];
  if (!year || !monthName || !day) return value;
  return `${Number(day)} ${monthName} ${year}`;
}

/**
 * A roadmap, read-only: the milestones on their timeline, in date order.
 *
 * The panel is narrower than the Workspace window, so the timeline runs down
 * the panel instead of across it. Each point keeps the milestone's status,
 * target date, title and description.
 */
export function RoadmapPreview({
  roadmap,
  milestones,
}: {
  roadmap: WorkspaceRoadmap;
  milestones: WorkspaceMilestone[];
}) {
  const ordered = [...milestones].sort((left, right) => {
    if (left.dueDate && right.dueDate) return left.dueDate.localeCompare(right.dueDate);
    if (left.dueDate) return -1;
    if (right.dueDate) return 1;
    return left.position - right.position || left.createdAt - right.createdAt;
  });

  return (
    <div
      className="preview-entity preview-roadmap"
      data-preview-entity="roadmap"
      data-id={roadmap.id}
    >
      <h2 className="preview-entity-title">{roadmap.name}</h2>
      {roadmap.description ? (
        <p className="preview-entity-note">{roadmap.description}</p>
      ) : null}
      {ordered.length === 0 ? (
        <p className="preview-roadmap-empty">No milestones yet.</p>
      ) : (
        <ol className="preview-roadmap-timeline">
          {ordered.map((milestone) => (
            <li
              className="preview-roadmap-item"
              data-status={milestone.status}
              key={milestone.id}
            >
              <span className="preview-roadmap-dot" aria-hidden="true" />
              <div className="preview-roadmap-card">
                <div className="preview-roadmap-meta">
                  <span className="preview-roadmap-status">
                    {MILESTONE_STATUS[milestone.status].label}
                  </span>
                  {milestone.dueDate ? (
                    <time dateTime={milestone.dueDate}>
                      {milestoneDate(milestone.dueDate)}
                    </time>
                  ) : null}
                </div>
                <h3>{milestone.title || "Untitled"}</h3>
                {milestone.description.trim() ? (
                  <p>{milestone.description}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * A brainstorm, read-only: the central word and the ideas around it.
 *
 * A narrow panel gets a plain list instead. Both views read the same stored
 * order (`position`, then when the idea was written), and more than six ideas
 * use the list at every width: a ring without overlap needs the room.
 */
export function BrainstormPreview({
  brainstorm,
  ideas,
}: {
  brainstorm: WorkspaceBrainstorm;
  ideas: WorkspaceBrainstormIdea[];
}) {
  const ordered = [...ideas].sort(
    (left, right) => left.position - right.position || left.createdAt - right.createdAt,
  );
  const radial = ordered.length > 0 && ordered.length <= 6;
  const radius =
    ordered.length <= 2 ? "min(22cqw, 88px)" : "min(30cqw, 118px)";

  const list = (
    <ol className="preview-brainstorm-list">
      {ordered.map((idea) => (
        <li className="preview-brainstorm-idea-list" key={idea.id}>
          {idea.text}
        </li>
      ))}
    </ol>
  );

  return (
    <div
      className="preview-entity preview-brainstorm"
      data-preview-entity="brainstorm"
      data-id={brainstorm.id}
      data-layout={radial ? "orbit" : "list"}
    >
      <h2 className="preview-entity-title">{brainstorm.name}</h2>
      {brainstorm.description ? (
        <p className="preview-entity-note">{brainstorm.description}</p>
      ) : null}
      {ordered.length === 0 ? (
        <p className="preview-brainstorm-empty">No ideas yet.</p>
      ) : (
        <>
          {radial && (
            <div className="preview-brainstorm-map">
              <div className="preview-brainstorm-center">
                <Lightbulb aria-hidden="true" />
                <span>{brainstorm.name}</span>
              </div>
              {ordered.map((idea, index) => (
                <div
                  className="preview-brainstorm-idea"
                  key={idea.id}
                  title={idea.text}
                  style={
                    {
                      "--angle": `${(index / ordered.length) * 360 - 90}deg`,
                      "--orbit-radius": radius,
                    } as CSSProperties
                  }
                >
                  {idea.text}
                </div>
              ))}
            </div>
          )}
          {list}
        </>
      )}
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
    case "roadmap":
    case "brainstorm":
      return null;
  }
}
