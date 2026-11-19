import { useState } from "react";
import { GripVertical, Plus } from "lucide-react";

import type { Board, Column, Task } from "../lib/types";
import { pendingPeople, taskAssignees } from "../lib/people";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { AssigneesPicker } from "./AssigneesPicker";

const EMPTY: never[] = [];

/** The value a column shows for a task, and how to write it back. */
function valueOf(task: Task, column: Column): string {
  if (column.type === "status") return task.status;
  if (column.type === "person") return taskAssignees(task)[0] ?? "";
  const raw = task.fields?.[column.id];
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return JSON.stringify(raw);
}

/**
 * A board as a table: one task per row, the board's own columns across.
 *
 * Status, people and options are selects so a change is one click; text is an
 * input that saves on blur. The grip on the left reorders the rows, which is
 * the same `position` the board view sorts by — the two views never disagree.
 */
export function BoardTable({ board, tasks }: { board: Board; tasks: Task[] }) {
  const openTask = useWorkspaceStore((state) => state.openTask);
  const createTask = useWorkspaceStore((state) => state.createTask);
  const updateTask = useWorkspaceStore((state) => state.updateTask);
  const reorderTasks = useWorkspaceStore((state) => state.reorderTasks);
  const members = useWorkspaceStore((state) =>
    board.projectId ? (state.members[board.projectId] ?? EMPTY) : EMPTY,
  );
  const pending = useWorkspaceStore((state) =>
    board.projectId ? (state.pending[board.projectId] ?? EMPTY) : EMPTY,
  );
  const invited = pendingPeople(members, pending);
  const activeTaskId = useWorkspaceStore((state) => state.activeTaskId);

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // A board without a person column still has assignees on its tasks, and a
  // table is where you expect to see them, so the table lends the column.
  const columns = board.columns.some((column) => column.type === "person")
    ? board.columns
    : [
        ...board.columns,
        { id: "assignee", name: "Assignee", type: "person" as const },
      ];
  const status = columns.find((column) => column.type === "status");
  const firstStatus = status?.options?.[0]?.id ?? "";

  const grid = {
    gridTemplateColumns: `minmax(240px, 1.7fr) ${columns
      .map(() => "minmax(132px, 0.7fr)")
      .join(" ")}`,
  };

  const drop = (targetId: string) => {
    const source = dragId;
    setDragId(null);
    setOverId(null);
    if (!source || source === targetId) return;
    const ids = tasks.map((task) => task.id).filter((id) => id !== source);
    const index = ids.indexOf(targetId);
    if (index < 0) return;
    ids.splice(index, 0, source);
    void reorderTasks(board.id, ids);
  };

  const setColumnValue = (task: Task, column: Column, value: string) => {
    if (column.type === "status") {
      void updateTask(task.id, { status: value });
      return;
    }
    const fields = { ...task.fields };
    if (value === "") delete fields[column.id];
    else fields[column.id] = column.type === "number" ? Number(value) : value;
    void updateTask(task.id, { fields });
  };

  return (
    <div className="ws-table-wrap">
      <div className="ws-table">
        <div className="ws-thead" style={grid}>
          <span className="ws-th ws-th-title">Task</span>
          {columns.map((column) => (
            <span className="ws-th" key={column.id}>
              {column.name}
            </span>
          ))}
        </div>

        {tasks.length === 0 ? (
          <div className="ws-table-empty">No tasks yet. Add the first one below.</div>
        ) : null}

        {tasks.map((task) => (
          <div
            key={task.id}
            className="ws-trow"
            style={grid}
            data-active={task.id === activeTaskId}
            data-dragging={dragId === task.id}
            data-over={Boolean(dragId) && dragId !== task.id && overId === task.id}
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              if (overId !== task.id) setOverId(task.id);
            }}
            onDragLeave={() => {
              if (overId === task.id) setOverId(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              drop(task.id);
            }}
          >
            <div className="ws-cell ws-cell-title">
              <span
                className="ws-grip"
                draggable
                role="button"
                tabIndex={0}
                title="Drag to reorder"
                aria-label={`Reorder ${task.title}`}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", task.id);
                  setDragId(task.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
              >
                <GripVertical strokeWidth={1.8} />
              </span>
              <button className="ws-cell-task" onClick={() => void openTask(task.id)}>
                <span className="ws-cell-task-title">{task.title}</span>
                {task.description ? (
                  <span className="ws-cell-task-note">{firstLine(task.description)}</span>
                ) : null}
              </button>
            </div>

            {columns.map((column) => {
              const value = valueOf(task, column);
              if (column.type === "text" || column.type === "number" || column.type === "date") {
                return (
                  <div className="ws-cell" key={column.id}>
                    <input
                      className="ws-cell-input"
                      key={`${task.id}-${value}`}
                      type={
                        column.type === "number"
                          ? "number"
                          : column.type === "date"
                            ? "date"
                            : "text"
                      }
                      defaultValue={value}
                      placeholder="—"
                      onBlur={(event) => {
                        if (event.target.value !== value) {
                          setColumnValue(task, column, event.target.value);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          event.currentTarget.value = value;
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </div>
                );
              }

              if (column.type === "person") {
                return (
                  <div className="ws-cell ws-cell-people" key={column.id}>
                    <AssigneesPicker
                      compact
                      values={taskAssignees(task)}
                      members={members}
                      invited={invited}
                      label={column.name}
                      onChange={(next) =>
                        void updateTask(task.id, { assignees: next, assignee: next[0] ?? null })
                      }
                    />
                  </div>
                );
              }

              const options = column.options ?? [];
              return (
                <div className="ws-cell" key={column.id}>
                  <select
                    className="ws-cell-select"
                    data-type={column.type}
                    value={value}
                    onChange={(event) => setColumnValue(task, column, event.target.value)}
                  >
                    {column.type === "select" ? <option value="">—</option> : null}
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label || "Untitled"}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        ))}

        <button
          className="ws-trow-add"
          style={grid}
          disabled={adding}
          onClick={async () => {
            setAdding(true);
            await createTask(board.id, firstStatus);
            setAdding(false);
          }}
        >
          <span className="ws-cell ws-cell-add">
            <Plus strokeWidth={2} />
            New task
          </span>
          {columns.map((column) => (
            <span className="ws-cell" key={column.id} />
          ))}
        </button>
      </div>
    </div>
  );
}

function firstLine(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((value) => value.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  return line ?? "";
}
