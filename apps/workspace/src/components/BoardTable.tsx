import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";

import { firstLine } from "@hook/markdown";

import type { Board, Column, Task } from "../lib/types";
import { pendingPeople, taskAssignees } from "../lib/people";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { AssigneesPicker } from "./AssigneesPicker";
import { MultiSelectMenu } from "./MultiSelectMenu";
import { PopupMenu, type MenuEntry } from "./PopupMenu";
import { SelectMenu } from "./SelectMenu";
import { TaskStatus } from "./TaskStatus";

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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function parseDateField(value: string): { year: number; month: number; day: number; time: string } | null {
  if (!value) return null;
  const [date, time = ""] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month: month - 1, day, time: time.slice(0, 5) };
}

function formatDateField(value: string, withTime: boolean): string {
  const parsed = parseDateField(value);
  if (!parsed) return "";
  const formatted = `${pad2(parsed.day)}/${pad2(parsed.month + 1)}/${parsed.year}`;
  return withTime && parsed.time ? `${formatted}, ${parsed.time}` : formatted;
}

function DateCell({
  value,
  type,
  label,
  onChange,
}: {
  value: string;
  type: "date" | "datetime";
  label: string;
  onChange: (value: string) => void;
}) {
  const withTime = type === "datetime";
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const selected = parseDateField(value);
  const today = new Date();
  const todayIso = isoDate(today.getFullYear(), today.getMonth(), today.getDate());
  const formatted = formatDateField(value, withTime);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popover.current?.contains(target)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const reposition = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const show = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const now = new Date();
    const base = parseDateField(value);
    setView({
      year: base?.year ?? now.getFullYear(),
      month: base?.month ?? now.getMonth(),
    });
    const width = 286;
    const height = 354;
    const left = Math.max(
      12,
      Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12),
    );
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 12 || rect.top < height + 18
      ? below
      : rect.top - height - 6;
    setPosition({ top: Math.max(12, top), left });
    setOpen(true);
  };

  const chooseDay = (day: number) => {
    const iso = isoDate(view.year, view.month, day);
    onChange(withTime ? `${iso}T${selected?.time || "09:00"}` : iso);
    setOpen(false);
  };

  const chooseToday = () => {
    onChange(withTime ? `${todayIso}T${selected?.time || "09:00"}` : todayIso);
    setOpen(false);
  };

  const changeTime = (time: string) => {
    const date = selected ? isoDate(selected.year, selected.month, selected.day) : todayIso;
    onChange(`${date}T${time || "09:00"}`);
  };

  const moveMonth = (step: number) => {
    setView((current) => {
      const next = new Date(current.year, current.month + step, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const cells: Array<number | null> = [];
  const firstDay = (new Date(view.year, view.month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  for (let i = 0; i < firstDay; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ws-date-cell"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
      >
        {withTime ? <CalendarClock aria-hidden="true" /> : <CalendarDays aria-hidden="true" />}
        <span aria-hidden="true">{formatted || (withTime ? "dd/mm/yyyy, --:--" : "dd/mm/yyyy")}</span>
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popover}
              className="ws-calendar"
              style={{ top: position.top, left: position.left }}
              role="dialog"
              aria-label={`${label} calendar`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ws-calendar-head">
                <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)}>
                  <ChevronLeft />
                </button>
                <strong>{MONTH_NAMES[view.month]} {view.year}</strong>
                <button type="button" aria-label="Next month" onClick={() => moveMonth(1)}>
                  <ChevronRight />
                </button>
              </div>
              <div className="ws-calendar-week" aria-hidden="true">
                {WEEKDAY_NAMES.map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className="ws-calendar-grid">
                {cells.map((day, index) => day === null ? (
                  <span className="ws-calendar-empty" key={`empty-${index}`} />
                ) : (
                  <button
                    key={day}
                    type="button"
                    className="ws-calendar-day"
                    data-today={isoDate(view.year, view.month, day) === todayIso}
                    data-selected={
                      selected?.year === view.year &&
                      selected?.month === view.month &&
                      selected?.day === day
                    }
                    aria-label={`${pad2(day)}/${pad2(view.month + 1)}/${view.year}`}
                    onClick={() => chooseDay(day)}
                  >
                    {day}
                  </button>
                ))}
              </div>
              {withTime ? (
                <label className="ws-calendar-time">
                  <span>Time</span>
                  <input
                    type="time"
                    value={selected?.time || "09:00"}
                    onChange={(event) => changeTime(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="ws-calendar-foot">
                <button type="button" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
                <button type="button" onClick={chooseToday}>Today</button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ProgressCell({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (value: number) => void;
}) {
  const numeric = value === "" ? Number.NaN : Number(value);
  const parsed = Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, Math.round(numeric)))
    : null;
  const [draft, setDraft] = useState(parsed ?? 0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) setDraft(parsed ?? 0);
  }, [parsed, dragging]);

  const commit = (next: number) => {
    if (next !== parsed) onChange(next);
  };

  return (
    <label className="ws-progress-cell" data-empty={parsed === null && !dragging}>
      <input
        className="ws-progress-input"
        type="range"
        min={0}
        max={100}
        step={1}
        value={draft}
        aria-label={label}
        style={{ "--progress": `${draft}%` } as CSSProperties}
        onChange={(event) => {
          setDragging(true);
          setDraft(Number(event.target.value));
        }}
        onPointerUp={(event) => {
          setDragging(false);
          commit(Number(event.currentTarget.value));
        }}
        onPointerCancel={(event) => {
          setDragging(false);
          commit(Number(event.currentTarget.value));
        }}
        onKeyUp={(event) => commit(Number(event.currentTarget.value))}
        onBlur={(event) => {
          if (!dragging) return;
          setDragging(false);
          commit(Number(event.currentTarget.value));
        }}
      />
      <small>{parsed === null && !dragging ? "—" : `${draft}%`}</small>
    </label>
  );
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
            <span
              className={`ws-th${column.type === "checkbox" ? " ws-th-check" : ""}`}
              key={column.id}
            >
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

              if (column.type === "status") {
                return (
                  <div className="ws-cell" key={column.id}>
                    <TaskStatus
                      column={column}
                      value={value}
                      readOnly={false}
                      onChange={(next) => setField(task, column, next)}
                    />
                  </div>
                );
              }

              if (column.type === "select") {
                return (
                  <div className="ws-cell" key={column.id}>
                    <SelectMenu
                      variant="cell"
                      value={value}
                      options={[{ id: "", label: "—" }, ...options]}
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

              if (column.type === "date" || column.type === "datetime") {
                return (
                  <div className="ws-cell ws-cell-date" key={column.id}>
                    <DateCell
                      value={value}
                      type={column.type}
                      label={column.name}
                      onChange={(next) => setField(task, column, next)}
                    />
                  </div>
                );
              }

              if (column.type === "progress") {
                return (
                  <div className="ws-cell" key={column.id}>
                    <ProgressCell
                      value={value}
                      label={column.name}
                      onChange={(next) => setField(task, column, next)}
                    />
                  </div>
                );
              }

              const inputType =
                column.type === "number"
                  ? "number"
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
                    defaultValue={value}
                    placeholder="—"
                    onBlur={(event) => {
                      if (event.target.value === value) return;
                      const next = column.type === "number"
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
