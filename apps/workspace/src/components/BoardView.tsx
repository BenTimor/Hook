import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LayoutList, Plus, Rows3 } from "lucide-react";

import type { Board, Member, Task } from "../lib/types";
import { pendingPeople, personFor, personLabel, unknownPerson } from "../lib/people";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { BoardTable } from "./BoardTable";
import { DocumentEditor } from "./DocumentEditor";

/**
 * A board as its columns: one column per status option, cards in order.
 *
 * Moving a card is a status change, not a drag: the server owns the order and
 * a keyboard-accessible select beats a drag for the first version. The card
 * opens the task view, where everything else is edited.
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
 * The task view. Description and title are edited in place and saved on blur,
 * so there is no Save button to forget.
 */
export function TaskPanel({ task }: { task: Task }) {
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

  const [title, setTitle] = useState(task.title);
  const [descriptionDirty, setDescriptionDirty] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const project = useWorkspaceStore((state) => state.projects.find((item) => item.id === state.activeProjectId));
  const readOnly = project?.role === "viewer";
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  // Whoever the task points at right now, however it is written: a member
  // (by subject), a member whose address an older task still carries, or
  // someone invited who has not accepted yet — shown by address alone.
  const assigned = personFor(members, task.assignee);
  const invited = pendingPeople(members, pending);
  const assignedEmail = task.assignee?.toLowerCase() ?? null;
  const assignedInvite = invited.find((invite) => invite.email === assignedEmail) ?? null;
  const assignedLabel = task.assignee
    ? assigned
      ? personLabel(assigned)
      : assignedInvite
        ? assignedInvite.email
        : unknownPerson(task.assignee)
    : null;

  return (
    <section className="ws-task" aria-label="Task details">
      <div className="ws-task-inner">
      <button className="ws-task-back" onClick={() => void openTask(null)}><ArrowLeft /> Back to board</button>
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
      </header>

      <div className="ws-task-layout">
      <div className="ws-task-main">
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
              {task.assignee ? <option value={task.assignee}>{assignedLabel}</option> : null}
              {members
                .filter((member) => member.subject !== task.assignee)
                .map((member) => (
                  <option key={member.subject} value={member.subject}>
                    {personLabel(member)}
                  </option>
                ))}
              {invited
                .filter((invite) => invite.email !== assignedEmail)
                .map((invite) => (
                  <option key={invite.id} value={invite.email}>
                    {invite.email}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>

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
      </div>

      <div className="ws-task-section ws-task-discussion">
        <div className="ws-task-section-heading"><div><h2>Discussion</h2><p>Keep the conversation with the work.</p></div><span className="ws-task-comment-count">{comments.length}</span></div>
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
      </div>
    </section>
  );
}

function authorName(members: Member[], subject: string): string {
  const member = members.find((candidate) => candidate.subject === subject);
  return personLabel(member);
}
