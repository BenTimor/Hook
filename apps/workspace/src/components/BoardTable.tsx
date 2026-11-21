import { useLayoutEffect, useRef, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";

import type { Board, Column, Task } from "../lib/types";
import { pendingPeople, taskAssignees } from "../lib/people";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { AssigneesPicker } from "./AssigneesPicker";
import { MultiSelectMenu } from "./MultiSelectMenu";
import { PopupMenu, type MenuEntry } from "./PopupMenu";
import { SelectMenu } from "./SelectMenu";

const EMPTY: never[] = [];

/** The raw value behind a property, regardless of its type. */
function rawValue(task: Task, column: Column): unknown {
  if (column.type === "status") return task.status;
  if (column.type === "person") return taskAssignees(task);
  return task.fields?.[column.id];
}

function valueText(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
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
  const deleteTask = useWorkspaceStore((state) => state.deleteTask);
  const members = useWorkspaceStore((state) =>
    board.projectId ? (state.members[board.projectId] ?? EMPTY) : EMPTY,
  );
  const pending = useWorkspaceStore((state) =>
    board.projectId ? (state.pending[board.projectId] ?? EMPTY) : EMPTY,
  );
  const invited = pendingPeople(members, pending);
  const activeTaskId = useWorkspaceStore((state) => state.activeTaskId);

  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const skipClick = useRef(false);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const [quickTitle, setQuickTitle] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const quickSaving = useRef(false);
  const quickCancelled = useRef(false);
  const table = useRef<HTMLDivElement>(null);
  const rowTops = useRef(new Map<string, number>());

  // A short FLIP animation after a drop: rows slide from their old position to
  // the new one instead of jumping.
  useLayoutEffect(() => {
    const rows = table.current?.querySelectorAll<HTMLElement>(".ws-trow[data-task-id]");
    if (!rows) return;
    const next = new Map<string, number>();
    for (const row of rows) {
      const id = row.dataset.taskId;
      if (!id) continue;
      const top = row.offsetTop;
      next.set(id, top);
      const previous = rowTops.current.get(id);
      if (previous === undefined || previous === top) continue;
      row.animate(
        [{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }],
        { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
    rowTops.current = next;
  });

  // Properties are explicit in the flexible model: a simple board should not
  // grow an assignee column it never asked for.
  const columns = board.columns.filter((column) => !column.hidden);
  const status = board.columns.find((column) => column.type === "status");
  const firstStatus = status?.options?.[0]?.id ?? "";

  const grid = {
    gridTemplateColumns: `minmax(240px, 1.7fr) ${columns
      .map(() => "minmax(132px, 0.7fr)")
      .join(" ")}`,
  };

  const drop = (targetId: string | null, after: boolean) => {
    const source = dragRef.current;
    dragRef.current = null;
    setDragId(null);
    setOver(null);
    if (source) {
      // A drop can be followed by a click; it should not also open the task.
      skipClick.current = true;
      window.setTimeout(() => {
        skipClick.current = false;
      }, 0);
    }
    if (!source || source === targetId) return;
    const ids = tasks.map((task) => task.id).filter((id) => id !== source);
    let index = targetId ? ids.indexOf(targetId) : -1;
    if (index < 0) index = ids.length;
    else if (after) index += 1;
    ids.splice(index, 0, source);
    void reorderTasks(board.id, ids);
  };

  const saveQuick = async () => {
    if (quickCancelled.current) {
      quickCancelled.current = false;
      return;
    }
    if (quickSaving.current || quickTitle === null) return;
    const title = quickTitle.trim();
    if (!title) {
      setQuickTitle(null);
      return;
    }
    quickSaving.current = true;
    setQuickBusy(true);
    const created = await createTask(board.id, firstStatus, { title, activate: false });
    quickSaving.current = false;
    setQuickBusy(false);
    if (created) setQuickTitle(null);
  };

  const setField = (task: Task, column: Column, value: unknown) => {
    if (column.type === "status") {
      void updateTask(task.id, { status: String(value ?? "") });
      return;
    }
    if (column.type === "person") {
      const next = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
      void updateTask(task.id, { assignees: next, assignee: next[0] ?? null });
      return;
    }
    const fields = { ...task.fields };
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      delete fields[column.id];
    } else {
      fields[column.id] = value;
    }
    void updateTask(task.id, { fields });
  };

  const menuEntries: MenuEntry[] = menu
    ? [
        {
          kind: "action",
          label: "Open task",
          onSelect: () => void openTask(menu.task.id),
        },
        { kind: "separator" },
        {
          kind: "action",
          label: "Delete task",
          icon: <Trash2 />,
          danger: true,
          onSelect: () => void deleteTask(menu.task.id),
        },
      ]
    : [];

  return (
    <div
      className="ws-table-wrap"
      data-dragging={Boolean(dragId)}
      onDragOver={(event) => {
        if (!dragRef.current) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setOver(null);
      }}
      onDrop={(event) => {
        if (!dragRef.current) return;
        event.preventDefault();
        const target = event.target instanceof Element ? event.target : null;
        const row = target?.closest<HTMLElement>(".ws-trow[data-task-id]");
        const id = row?.dataset.taskId ?? null;
        if (!row || !id) {
          const first = table.current?.querySelector<HTMLElement>(".ws-trow[data-task-id]");
          if (first?.dataset.taskId && event.clientY < first.getBoundingClientRect().top) {
            drop(first.dataset.taskId, false);
          } else {
            drop(null, true);
          }
          return;
        }
        const rect = row.getBoundingClientRect();
        drop(id, event.clientY > rect.top + rect.height / 2);
      }}
    >
      <div className="ws-table" ref={table}>
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
            data-task-id={task.id}
            data-active={task.id === activeTaskId}
            data-dragging={dragId === task.id}
            data-over={
              dragId && dragId !== task.id && over?.id === task.id
                ? over.after
                  ? "after"
                  : "before"
                : undefined
            }
            onDragOver={(event) => {
              if (!dragRef.current) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const rect = event.currentTarget.getBoundingClientRect();
              const after = event.clientY > rect.top + rect.height / 2;
              if (over?.id !== task.id || over.after !== after) setOver({ id: task.id, after });
            }}
            onClick={(event) => {
              if (skipClick.current) return;
              const target = event.target instanceof Element ? event.target : null;
              if (
                target?.closest(
                  "button, input, select, textarea, a, [role='button'], [contenteditable='true']",
                )
              ) {
                return;
              }
              void openTask(task.id);
            }}
            onContextMenu={(event) => {
              const target = event.target instanceof Element ? event.target : null;
              if (target?.closest("input, textarea, [contenteditable='true']")) return;
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, task });
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
                  const row = event.currentTarget.closest<HTMLElement>(".ws-trow");
                  if (row) {
                    const rect = row.getBoundingClientRect();
                    event.dataTransfer.setDragImage(
                      row,
                      event.clientX - rect.left,
                      event.clientY - rect.top,
                    );
                  }
                  dragRef.current = task.id;
                  setDragId(task.id);
                  setOver(null);
                }}
                onDragEnd={() => {
                  dragRef.current = null;
                  setDragId(null);
                  setOver(null);
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
              const raw = rawValue(task, column);
              const value = valueText(raw);
              const options = (column.options ?? []).map((option) => ({
                id: option.id,
                label: option.label || "Untitled",
                color: option.color,
              }));

              if (column.type === "person") {
                const people = Array.isArray(raw)
                  ? raw.filter((entry): entry is string => typeof entry === "string")
                  : [];
                return (
                  <div className="ws-cell ws-cell-people" key={column.id}>
                    <AssigneesPicker
                      compact
                      values={people}
                      members={members}
                      invited={invited}
                      label={column.name}
                      onChange={(next) => setField(task, column, next)}
                    />
                  </div>
                );
              }

              if (column.type === "status" || column.type === "select") {
                return (
                  <div className="ws-cell" key={column.id}>
                    <SelectMenu
                      variant="cell"
                      value={value}
                      options={column.type === "select" ? [{ id: "", label: "—" }, ...options] : options}
                      label={column.name}
                      onChange={(next) => setField(task, column, next)}
                    />
                  </div>
                );
              }

              if (column.type === "multiselect") {
                const values = Array.isArray(raw)
                  ? raw.filter((entry): entry is string => typeof entry === "string")
                  : [];
                return (
                  <div className="ws-cell" key={column.id}>
                    <MultiSelectMenu
                      values={values}
                      options={options}
                      label={column.name}
                      onChange={(next) => setField(task, column, next)}
                    />
                  </div>
                );
              }

              if (column.type === "checkbox") {
                return (
                  <div className="ws-cell ws-cell-check" key={column.id}>
                    <input
                      type="checkbox"
                      aria-label={column.name}
                      checked={raw === true}
                      onChange={(event) => setField(task, column, event.target.checked)}
                    />
                  </div>
                );
              }

              if (column.type === "daterange") {
                const range = raw && typeof raw === "object" && !Array.isArray(raw)
                  ? (raw as { start?: unknown; end?: unknown })
                  : {};
                const start = typeof range.start === "string" ? range.start : "";
                const end = typeof range.end === "string" ? range.end : "";
                return (
                  <div className="ws-cell ws-cell-range" key={column.id}>
                    <input
                      className="ws-cell-input"
                      type="date"
                      aria-label={`${column.name} start`}
                      value={start}
                      onChange={(event) => setField(task, column, { start: event.target.value, end })}
                    />
                    <span aria-hidden="true">–</span>
                    <input
                      className="ws-cell-input"
                      type="date"
                      aria-label={`${column.name} end`}
                      value={end}
                      onChange={(event) => setField(task, column, { start, end: event.target.value })}
                    />
                  </div>
                );
              }

              const inputType =
                column.type === "number" || column.type === "progress"
                  ? "number"
                  : column.type === "date"
                    ? "date"
                    : column.type === "datetime"
                      ? "datetime-local"
                      : column.type === "url"
                        ? "url"
                        : column.type === "email"
                          ? "email"
                          : column.type === "phone"
                            ? "tel"
                            : "text";
              return (
                <div className="ws-cell" key={column.id}>
                  <input
                    className="ws-cell-input"
                    key={`${task.id}-${value}`}
                    type={inputType}
                    min={column.type === "progress" ? 0 : undefined}
                    max={column.type === "progress" ? 100 : undefined}
                    defaultValue={value}
                    placeholder="—"
                    onBlur={(event) => {
                      if (event.target.value === value) return;
                      const next =
                        column.type === "number" || column.type === "progress"
                          ? event.target.value === ""
                            ? null
                            : Number(event.target.value)
                          : event.target.value;
                      setField(task, column, next);
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
            })}
          </div>
        ))}

        {quickTitle !== null ? (
          <div className="ws-trow ws-trow-quick" style={grid}>
            <div className="ws-cell ws-cell-title ws-quick-cell">
              <span className="ws-quick-mark" aria-hidden="true">
                <Plus strokeWidth={2} />
              </span>
              <input
                className="ws-quick-input"
                autoFocus
                value={quickTitle}
                placeholder="Task name"
                aria-label="New task title"
                disabled={quickBusy}
                onChange={(event) => setQuickTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    quickCancelled.current = false;
                    void saveQuick();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    quickCancelled.current = true;
                    setQuickTitle(null);
                  }
                }}
                onBlur={() => void saveQuick()}
              />
            </div>
            {columns.map((column) => (
              <span className="ws-cell" key={column.id} />
            ))}
          </div>
        ) : (
          <button
            className="ws-trow-add"
            style={grid}
            onClick={() => {
              quickCancelled.current = false;
              setQuickTitle("");
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
        )}
      </div>
      {menu ? (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries}
          onClose={() => setMenu(null)}
        />
      ) : null}
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
