import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LayoutList, Pencil, Plus, Rows3, Trash2 } from "lucide-react";

import type { Board, Comment, Member, Task } from "../lib/types";
import { pendingPeople, personLabel, taskAssignees } from "../lib/people";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { AssigneesPicker, PersonAvatar } from "./AssigneesPicker";
import { BoardTable } from "./BoardTable";
import { DocumentEditor } from "./DocumentEditor";
import { TaskStatus } from "./TaskStatus";

/**
 * A board as its columns: one column per status option, cards in order.
 *
 * Dragging a card to another column changes its status; opening the card still
 * edits everything else. The status select in the task view remains the
 * keyboard-accessible path to the same change.
 */
export function BoardPage({ board, tasks }: { board: Board; tasks: Task[] }) {
  const createTask = useWorkspaceStore((state) => state.createTask);
  const [mode, setMode] = useState<"table" | "board">("table");
  const [adding, setAdding] = useState(false);
  const status = board.columns.find((column) => column.type === "status");

  return (
    <div className="ws-board-page">
      <header className="ws-page-head">
        <div className="ws-page-title">
          <h1>{board.name}</h1>
          {board.description ? <p>{board.description}</p> : null}
        </div>
        <div className="ws-page-actions">
          <div className="ws-segment" role="tablist" aria-label="Board view">
            <button
              role="tab"
              data-active={mode === "table"}
              onClick={() => setMode("table")}
              title="Table view"
            >
              <Rows3 strokeWidth={1.8} />
              Table
            </button>
            <button
              role="tab"
              data-active={mode === "board"}
              onClick={() => setMode("board")}
              title="Board view"
            >
              <LayoutList strokeWidth={1.8} />
              Board
            </button>
          </div>
          <button
            className="btn btn-primary"
            disabled={adding}
            onClick={async () => {
              setAdding(true);
              await createTask(board.id, status?.options?.[0]?.id ?? "");
              setAdding(false);
            }}
          >
            <Plus /> New task
          </button>
        </div>
      </header>

      {mode === "table" ? (
        <BoardTable board={board} tasks={tasks} />
      ) : (
        <BoardColumns board={board} tasks={tasks} />
      )}
    </div>
  );
}

export function BoardColumns({ board, tasks }: { board: Board; tasks: Task[] }) {
  const openTask = useWorkspaceStore((state) => state.openTask);
  const createTask = useWorkspaceStore((state) => state.createTask);
  const updateTask = useWorkspaceStore((state) => state.updateTask);
  const activeTaskId = useWorkspaceStore((state) => state.activeTaskId);
  const [pending, setPending] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  // Show the card in its destination immediately; the task row catches up
  // when the server answers.
  const [moving, setMoving] = useState<Record<string, string>>({});
  const [arrived, setArrived] = useState<string | null>(null);

  const status = board.columns.find((column) => column.type === "status");
  const columns = status?.options ?? [];
  const statusOf = (task: Task) => moving[task.id] ?? task.status;
  const extra = tasks.filter(
    (task) => !columns.some((option) => option.id === statusOf(task)),
  );

  const moveTask = async (taskId: string, columnId: string) => {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || statusOf(task) === columnId) return;
    const position = tasks
      .filter((candidate) => candidate.id !== taskId && statusOf(candidate) === columnId)
      .reduce((next, candidate) => Math.max(next, candidate.position + 1), 0);
    setMoving((current) => ({ ...current, [taskId]: columnId }));
    setArrived(taskId);
    window.setTimeout(() => setArrived((current) => (current === taskId ? null : current)), 320);
    await updateTask(taskId, { status: columnId, position });
    setMoving((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  };

  return (
    <div
      className="ws-board"
      data-dragging={Boolean(dragId)}
      onDragOver={(event) => {
        if (!dragRef.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragRef.current = null;
        setDragId(null);
        setOverColumn(null);
      }}
    >
      {columns.map((column) => {
        const items = tasks.filter((task) => statusOf(task) === column.id);
        return (
          <section
            className="ws-column"
            key={column.id}
            data-over={overColumn === column.id && Boolean(dragId)}
            onDragOver={(event) => {
              if (!dragRef.current) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overColumn !== column.id) setOverColumn(column.id);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              if (overColumn === column.id) setOverColumn(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData("text/plain") || dragRef.current;
              dragRef.current = null;
              setDragId(null);
              setOverColumn(null);
              if (id) void moveTask(id, column.id);
            }}
          >
            <header className="ws-column-head">
              <span className="ws-column-name">{column.label}</span>
              <span className="ws-column-count">{items.length}</span>
              <button
                className="icon-btn"
                title={`New task in ${column.label}`}
                disabled={pending === column.id}
                onClick={async () => {
                  setPending(column.id);
                  await createTask(board.id, column.id);
                  setPending(null);
                }}
              >
                <Plus strokeWidth={2} />
              </button>
            </header>
            <div className="ws-column-body">
              {items.map((task) => (
                <button
                  className="ws-card"
                  key={task.id}
                  draggable
                  data-active={task.id === activeTaskId}
                  data-dragging={dragId === task.id}
                  data-arrived={arrived === task.id}
                  onClick={() => void openTask(task.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", task.id);
                    dragRef.current = task.id;
                    setDragId(task.id);
                    setOverColumn(null);
                  }}
                  onDragEnd={() => {
                    dragRef.current = null;
                    setDragId(null);
                    setOverColumn(null);
                  }}
                >
                  <span className="ws-card-title">{task.title}</span>
                  {task.description ? (
                    <span className="ws-card-note">{firstLine(task.description)}</span>
                  ) : null}
                </button>
              ))}
              {items.length === 0 && <div className="ws-column-empty">Nothing here yet</div>}
            </div>
          </section>
        );
      })}
      {columns.length === 0 && (
        <section className="ws-column">
          <header className="ws-column-head">
            <span className="ws-column-name">Tasks</span>
            <span className="ws-column-count">{tasks.length}</span>
          </header>
          <div className="ws-column-body">
            {tasks.map((task) => (
              <button className="ws-card" key={task.id} onClick={() => void openTask(task.id)}>
                <span className="ws-card-title">{task.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {extra.length > 0 && (
        <section className="ws-column">
          <header className="ws-column-head">
            <span className="ws-column-name">Other</span>
            <span className="ws-column-count">{extra.length}</span>
          </header>
          <div className="ws-column-body">
            {extra.map((task) => (
              <button className="ws-card" key={task.id} onClick={() => void openTask(task.id)}>
                <span className="ws-card-title">{task.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const EMPTY: never[] = [];

function firstLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((value) => value.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  return line ?? "";
}

/**
 * The task view. Description and title are edited in place and saved on blur,
 * so there is no Save button to forget.
 */
export function TaskPanel({ task, accountEmail }: { task: Task; accountEmail?: string | null }) {
  const members = useWorkspaceStore((state) =>
    state.activeProjectId ? (state.members[state.activeProjectId] ?? EMPTY) : EMPTY,
  );
  const pending = useWorkspaceStore((state) =>
    state.activeProjectId ? (state.pending[state.activeProjectId] ?? EMPTY) : EMPTY,
  );
  const board = useWorkspaceStore((state) => {
    if (!state.activeProjectId) return null;
    return (state.boards[state.activeProjectId] ?? []).find((item) => item.id === task.boardId) ?? null;
  });
  const comments = useWorkspaceStore((state) => state.comments[task.id] ?? EMPTY);
  const updateTask = useWorkspaceStore((state) => state.updateTask);
  const deleteTask = useWorkspaceStore((state) => state.deleteTask);
  const openTask = useWorkspaceStore((state) => state.openTask);
  const addComment = useWorkspaceStore((state) => state.addComment);
  const editComment = useWorkspaceStore((state) => state.editComment);
  const deleteComment = useWorkspaceStore((state) => state.deleteComment);

  const [title, setTitle] = useState(task.title);
  const [descriptionDirty, setDescriptionDirty] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const project = useWorkspaceStore((state) => state.projects.find((item) => item.id === state.activeProjectId));
  const readOnly = project?.role === "viewer";
  const canManage = project?.role === "manager" || project?.role === "owner";
  const currentSubject = accountEmail
    ? members.find((member) => member.email?.toLowerCase() === accountEmail.toLowerCase())?.subject
    : undefined;
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [confirmComment, setConfirmComment] = useState<string | null>(null);
  useEffect(() => {
    setTitle(task.title);
  }, [task.title]);

  const status = board?.columns.find((column) => column.type === "status");
  // Every task has assignees; only some boards give them a column of their own.
  const assigneeColumn = board?.columns.find((column) => column.type === "person") ?? {
    id: "assignee",
    name: "Assignees",
    type: "person" as const,
  };
  const assigned = taskAssignees(task);
  const invited = pendingPeople(members, pending);
  const creator = personLabel(members.find((member) => member.subject === task.createdBy));
  const canChangeComment = (comment: Comment) =>
    !readOnly && (canManage || comment.author === currentSubject);
  const beginEditComment = (comment: Comment) => {
    setEditingComment(comment.id);
    setCommentDraft(comment.body);
    setConfirmComment(null);
  };
  const saveComment = async (comment: Comment) => {
    const body = commentDraft.trim();
    if (!body || body === comment.body) {
      setEditingComment(null);
      return;
    }
    if (await editComment(task.id, comment.id, body)) setEditingComment(null);
  };

  return (
    <section className="ws-task" aria-label="Task details">
      <div className="ws-task-inner">
        <div className="ws-task-topbar">
          <button className="ws-task-back" onClick={() => void openTask(null)}>
            <ArrowLeft /> {board?.name ?? "Back to board"}
          </button>
          <span className="ws-task-topbar-label">Task</span>
        </div>

        <header className="ws-task-head">
          <input
            className="ws-task-title"
            value={title}
            readOnly={readOnly}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              const next = title.trim();
              if (next && next !== task.title) void updateTask(task.id, { title: next });
              else setTitle(task.title);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setTitle(task.title);
                event.currentTarget.blur();
              }
            }}
          />
          {!readOnly ? (
            <div className="ws-task-head-actions">
              {confirmDelete ? (
                <div className="ws-task-delete-confirm">
                  <span>Delete task?</span>
                  <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Keep</button>
                  <button
                    className="ws-task-delete-danger"
                    onClick={() => {
                      void deleteTask(task.id);
                      setConfirmDelete(false);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="ws-task-delete"
                  title="Delete task"
                  aria-label="Delete task"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 />
                  Delete
                </button>
              )}
            </div>
          ) : null}
        </header>

        <div className="ws-task-layout">
          <div className="ws-task-main">
            <div className="ws-task-section">
              <div className="ws-task-section-heading">
                <div><h2>Description</h2><p>Give this task the context it needs.</p></div>
                <div className="ws-task-description-actions">
                  <span aria-live="polite">{descriptionDirty ? "Saving…" : "Saved"}</span>
                  <button type="button" className="ws-task-source" onClick={() => setSourceMode(!sourceMode)}>{sourceMode ? "Formatted" : "Markdown"}</button>
                </div>
              </div>
              <DocumentEditor
                document={{ id: task.id, markdown: task.description }}
                raw={sourceMode}
                readOnly={readOnly}
                compact
                onChange={setDescriptionDirty}
                onSave={(markdown) => {
                  const pendingSave = saveQueue.current.catch(() => false).then(() => updateTask(task.id, { description: markdown }));
                  saveQueue.current = pendingSave;
                  return pendingSave;
                }}
              />
            </div>

            <div className="ws-task-section ws-task-discussion">
              <div className="ws-task-section-heading">
                <div><h2>Discussion</h2><p>Keep the conversation with the work.</p></div>
                <span className="ws-task-comment-count">{comments.length}</span>
              </div>
              {comments.length === 0 ? (
                <p className="ws-task-empty">No comments yet. Start the conversation below.</p>
              ) : (
                comments.map((comment) => {
                  const name = authorName(members, comment.author);
                  return (
                    <div className="ws-comment" key={comment.id}>
                      <div className="ws-comment-head">
                        <PersonAvatar small value={comment.author} label={name} />
                        <span>{name}</span>
                        {comment.authorKind === "agent" && (
                          <span className="ws-agent-tag">via Hook agent</span>
                        )}
                        {comment.updatedAt > comment.createdAt ? (
                          <span className="ws-comment-edited">edited</span>
                        ) : null}
                        {canChangeComment(comment) && editingComment !== comment.id ? (
                          <div className="ws-comment-actions">
                            {confirmComment === comment.id ? (
                              <span className="ws-comment-confirm">
                                Delete comment?
                                <button
                                  type="button"
                                  onClick={() => {
                                    void deleteComment(task.id, comment.id);
                                    setConfirmComment(null);
                                  }}
                                >
                                  Delete
                                </button>
                                <button type="button" onClick={() => setConfirmComment(null)}>
                                  Keep
                                </button>
                              </span>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  title="Edit comment"
                                  aria-label="Edit comment"
                                  onClick={() => beginEditComment(comment)}
                                >
                                  <Pencil aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  title="Delete comment"
                                  aria-label="Delete comment"
                                  onClick={() => setConfirmComment(comment.id)}
                                >
                                  <Trash2 aria-hidden="true" />
                                </button>
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>
                      {editingComment === comment.id ? (
                        <div className="ws-comment-editor">
                          <textarea
                            className="ws-comment-input"
                            value={commentDraft}
                            autoFocus
                            aria-label="Edit comment"
                            onChange={(event) => setCommentDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setEditingComment(null);
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && commentDraft.trim()) {
                                void saveComment(comment);
                              }
                            }}
                          />
                          <div className="ws-comment-editor-actions">
                            <button className="btn btn-ghost" onClick={() => setEditingComment(null)}>Cancel</button>
                            <button
                              className="btn"
                              disabled={!commentDraft.trim() || commentDraft.trim() === comment.body}
                              onClick={() => void saveComment(comment)}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p>{comment.body}</p>
                      )}
                    </div>
                  );
                })
              )}
              <div className="ws-comment-compose">
                <textarea
                  className="ws-comment-input"
                  value={draft}
                  placeholder="Write a comment…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && draft.trim()) {
                      void addComment(task.id, draft.trim());
                      setDraft("");
                    }
                  }}
                />
                <button
                  className="btn"
                  disabled={!draft.trim()}
                  onClick={() => {
                    void addComment(task.id, draft.trim());
                    setDraft("");
                  }}
                >
                  Comment
                </button>
              </div>
            </div>
          </div>

          <aside className="ws-task-side" aria-label="Task properties">
            <div className="ws-task-properties">
              <div className="ws-task-properties-heading"><h2>Details</h2></div>
              {status ? (
                <div className="ws-property">
                  <span className="ws-property-label">{status.name}</span>
                  <TaskStatus
                    column={status}
                    value={task.status}
                    readOnly={readOnly}
                    onChange={(value) => void updateTask(task.id, { status: value })}
                  />
                </div>
              ) : null}
              <div className="ws-property">
                <span className="ws-property-label">{assigneeColumn.name}</span>
                <AssigneesPicker
                  values={assigned}
                  members={members}
                  invited={invited}
                  readOnly={readOnly}
                  label={assigneeColumn.name}
                  onChange={(next) => updateTask(task.id, { assignees: next, assignee: next[0] ?? null })}
                />
              </div>
              <div className="ws-property ws-property-row">
                <span className="ws-property-label">Created by</span>
                <span className="ws-property-value ws-property-person">
                  <PersonAvatar small value={task.createdBy} label={creator} />
                  <span>{creator}</span>
                </span>
              </div>
              <div className="ws-property ws-property-row">
                <span className="ws-property-label">Created</span>
                <span className="ws-property-value">{formatDate(task.createdAt)}</span>
              </div>
              <div className="ws-property ws-property-row">
                <span className="ws-property-label">Updated</span>
                <span className="ws-property-value">{formatDate(task.updatedAt)}</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function authorName(members: Member[], subject: string): string {
  const member = members.find((candidate) => candidate.subject === subject);
  return personLabel(member);
}

function formatDate(value: number): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}
