import { useEffect, useRef, useState } from "react";
import { LayoutList, Plus, Rows3 } from "lucide-react";

import type { Board, Task } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { BoardTable } from "./BoardTable";

/**
 * A board as its columns: one column per status option, cards in order.
 *
 * Moving a card is a status change, not a drag: the server owns the order and
 * a keyboard-accessible select beats a drag for the first version. The card
 * opens the task panel, where everything else is edited.
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
  const activeTaskId = useWorkspaceStore((state) => state.activeTaskId);
  const [pending, setPending] = useState<string | null>(null);

  const status = board.columns.find((column) => column.type === "status");
  const columns = status?.options ?? [];
  const extra = tasks.filter(
    (task) => !columns.some((option) => option.id === task.status),
  );

  return (
    <div className="ws-board">
      {columns.map((column) => {
        const items = tasks.filter((task) => task.status === column.id);
        return (
          <section className="ws-column" key={column.id}>
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
                  data-active={task.id === activeTaskId}
                  onClick={() => void openTask(task.id)}
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
 * The task panel. Description and title are edited in place and saved on blur,
 * so there is no Save button to forget.
 */
export function TaskPanel({ task }: { task: Task }) {
  const members = useWorkspaceStore((state) =>
    state.activeProjectId ? (state.members[state.activeProjectId] ?? EMPTY) : EMPTY,
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

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // The feed can replace the task under us; follow it unless the field is
  // focused, so a teammate's rename lands without eating what is being typed.
  useEffect(() => {
    if (document.activeElement !== descriptionRef.current) setDescription(task.description);
  }, [task.description]);
  useEffect(() => {
    setTitle(task.title);
  }, [task.title]);

  const status = board?.columns.find((column) => column.type === "status");
  // Every task has an assignee; only some boards give it a column of its own.
  const assigneeColumn = board?.columns.find((column) => column.type === "person") ?? {
    id: "assignee",
    name: "Assignee",
    type: "person" as const,
  };

  return (
    <aside className="ws-task">
      <header className="ws-task-head">
        <input
          className="ws-task-title"
          value={title}
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
        <button className="icon-btn" title="Close" onClick={() => void openTask(null)}>
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div className="ws-task-fields">
        {status ? (
          <label className="ws-field">
            <span>{status.name}</span>
            <select
              className="text-input"
              value={task.status}
              onChange={(event) => void updateTask(task.id, { status: event.target.value })}
            >
              {status.options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {assigneeColumn ? (
          <label className="ws-field">
            <span>{assigneeColumn.name}</span>
            <select
              className="text-input"
              value={task.assignee ?? ""}
              onChange={(event) =>
                void updateTask(task.id, { assignee: event.target.value || null })
              }
            >
              <option value="">Unassigned</option>
              {task.assignee && !members.some((member) => member.subject === task.assignee) ? (
                <option value={task.assignee}>{task.assignee} (not in this project)</option>
              ) : null}
              {members.map((member) => (
                <option key={member.subject} value={member.subject}>
                  {member.name || member.email || member.subject}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="ws-task-section">
        <div className="ws-task-label">Description</div>
        <textarea
          ref={descriptionRef}
          className="ws-task-description"
          value={description}
          placeholder="Markdown works here."
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => {
            if (description !== task.description) {
              void updateTask(task.id, { description });
            }
          }}
        />
      </div>

      <div className="ws-task-section">
        <div className="ws-task-label">Comments</div>
        {comments.map((comment) => (
          <div className="ws-comment" key={comment.id}>
            <div className="ws-comment-head">
              <span>{authorName(members, comment.author)}</span>
              {comment.authorKind === "agent" && (
                <span className="ws-agent-tag">via Hook agent</span>
              )}
            </div>
            <p>{comment.body}</p>
          </div>
        ))}
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

      <footer className="ws-task-foot">
        {confirmDelete ? (
          <>
            <span>Delete this task for everyone?</span>
            <button
              className="btn btn-ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Keep
            </button>
            <button
              className="btn"
              onClick={() => {
                void deleteTask(task.id);
                setConfirmDelete(false);
              }}
            >
              Delete
            </button>
          </>
        ) : (
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
            Delete task
          </button>
        )}
      </footer>
    </aside>
  );
}

function authorName(
  members: Array<{ subject: string; email: string | null; name: string | null }>,
  subject: string,
): string {
  const member = members.find((candidate) => candidate.subject === subject);
  return member?.name || member?.email || subject;
}
