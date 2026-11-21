import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlignLeft,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CheckSquare,
  CircleDot,
  Gauge,
  GripVertical,
  Hash,
  Link2,
  ListChecks,
  ListFilter,
  Mail,
  Phone,
  Plus,
  Trash2,
  Type,
  UserRound,
  Eye,
  EyeOff,
} from "lucide-react";
import { Dialog } from "@hook/ui";

import type { Board, Column, ColumnOption, ColumnType, Task } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { STATUS_COLORS, statusColor } from "./TaskStatus";

const EMPTY: Task[] = [];

const newId = (prefix: "col" | "opt") =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const TYPE_LABEL: Record<ColumnType, string> = {
  status: "Status",
  text: "Text",
  longtext: "Long text",
  number: "Number",
  checkbox: "Checkbox",
  select: "Select",
  multiselect: "Multi-select",
  person: "Person",
  date: "Date",
  datetime: "Date & time",
  daterange: "Timeline",
  progress: "Progress",
  url: "URL",
  email: "Email",
  phone: "Phone",
};

function PropertyTypeIcon({ type }: { type: ColumnType }) {
  switch (type) {
    case "status": return <CircleDot />;
    case "select": return <ListFilter />;
    case "multiselect": return <ListChecks />;
    case "person": return <UserRound />;
    case "date": return <CalendarDays />;
    case "datetime": return <CalendarClock />;
    case "daterange": return <CalendarRange />;
    case "checkbox": return <CheckSquare />;
    case "number": return <Hash />;
    case "progress": return <Gauge />;
    case "url": return <Link2 />;
    case "email": return <Mail />;
    case "phone": return <Phone />;
    case "longtext": return <AlignLeft />;
    default: return <Type />;
  }
}

const OPTION_TYPES: ColumnType[] = ["status", "select", "multiselect"];
const HAS_OPTIONS = (type: ColumnType) => OPTION_TYPES.includes(type);

interface TypeChoice {
  type: ColumnType;
  label: string;
  options?: string[];
}

const TYPE_GROUPS: Array<{ label: string; choices: TypeChoice[] }> = [
  {
    label: "Suggested",
    choices: [
      { type: "status", label: "Status" },
      { type: "person", label: "Assignee" },
      { type: "date", label: "Due date" },
      { type: "select", label: "Priority", options: ["Low", "Medium", "High"] },
    ],
  },
  {
    label: "Text",
    choices: [
      { type: "text", label: "Text" },
      { type: "longtext", label: "Long text" },
      { type: "url", label: "URL" },
      { type: "email", label: "Email" },
      { type: "phone", label: "Phone" },
    ],
  },
  {
    label: "Choice",
    choices: [
      { type: "select", label: "Select" },
      { type: "multiselect", label: "Multi-select" },
    ],
  },
  {
    label: "Number & dates",
    choices: [
      { type: "number", label: "Number" },
      { type: "checkbox", label: "Checkbox" },
      { type: "date", label: "Date" },
      { type: "datetime", label: "Date & time" },
      { type: "daterange", label: "Timeline" },
      { type: "progress", label: "Progress" },
    ],
  },
];

function defaultOptions(type: ColumnType): ColumnOption[] | undefined {
  if (type === "status") {
    return ["To do", "In progress", "Done"].map((label) => ({
      id: newId("opt"),
      label,
      color: statusColor(label),
    }));
  }
  if (type === "select" || type === "multiselect") {
    return ["Option 1", "Option 2"].map((label) => ({ id: newId("opt"), label }));
  }
  return undefined;
}

interface PreviewState {
  choice: TypeChoice;
  top: number;
  left: number;
}

function PropertyPreviewValue({ choice }: { choice: TypeChoice }) {
  switch (choice.type) {
    case "status":
      return (
        <span className="ws-prop-preview-pills">
          {["To do", "In progress", "Done"].map((label) => (
            <span key={label} className="ws-status-pill" data-color={statusColor(label)}>
              <span className="ws-status-dot" aria-hidden="true" />
              <span>{label}</span>
            </span>
          ))}
        </span>
      );
    case "select":
      return <span className="ws-prop-preview-chip">Medium</span>;
    case "multiselect":
      return (
        <span className="ws-prop-preview-pills">
          <span className="ws-prop-preview-chip">Design</span>
          <span className="ws-prop-preview-chip">Urgent</span>
        </span>
      );
    case "person":
      return (
        <span className="ws-prop-preview-person">
          <span className="ws-prop-preview-avatar" aria-hidden="true">AM</span>
          <span>Alex Morgan</span>
        </span>
      );
    case "date":
      return (
        <span className="ws-prop-preview-field">
          <CalendarDays aria-hidden="true" />
          <span>May 24</span>
        </span>
      );
    case "datetime":
      return (
        <span className="ws-prop-preview-field">
          <CalendarClock aria-hidden="true" />
          <span>May 24, 14:30</span>
        </span>
      );
    case "daterange":
      return (
        <span className="ws-prop-preview-field">
          <CalendarRange aria-hidden="true" />
          <span>May 24 – May 30</span>
        </span>
      );
    case "checkbox":
      return (
        <span className="ws-prop-preview-person">
          <CheckSquare aria-hidden="true" />
          <span>Checked</span>
        </span>
      );
    case "number":
      return <span className="ws-prop-preview-field">12</span>;
    case "progress":
      return (
        <span className="ws-prop-preview-progress">
          <span><span style={{ width: "60%" }} /></span>
          <small>60%</small>
        </span>
      );
    case "url":
      return (
        <span className="ws-prop-preview-field ws-prop-preview-link">
          <Link2 aria-hidden="true" />
          <span>example.com</span>
        </span>
      );
    case "email":
      return (
        <span className="ws-prop-preview-field ws-prop-preview-link">
          <Mail aria-hidden="true" />
          <span>alex@example.com</span>
        </span>
      );
    case "phone":
      return (
        <span className="ws-prop-preview-field">
          <Phone aria-hidden="true" />
          <span>+1 555 0100</span>
        </span>
      );
    case "longtext":
      return <span className="ws-prop-preview-longtext">A longer note that can wrap across lines.</span>;
    default:
      return <span className="ws-prop-preview-field">Short answer</span>;
  }
}

function PropertyTypePreview({ preview }: { preview: PreviewState }) {
  return createPortal(
    <div
      className="ws-prop-preview"
      style={{ top: preview.top, left: preview.left }}
      role="tooltip"
      aria-label={`${preview.choice.label} preview`}
    >
      <div className="ws-prop-preview-head">
        <span className="ws-prop-type-icon" data-type={preview.choice.type} aria-hidden="true">
          <PropertyTypeIcon type={preview.choice.type} />
        </span>
        <span className="ws-prop-preview-title">
          <strong>{preview.choice.label}</strong>
          <small>{TYPE_LABEL[preview.choice.type]}</small>
        </span>
      </div>
      <div className="ws-prop-preview-body">
        <span className="ws-prop-preview-caption">Preview</span>
        <div className="ws-prop-preview-value">
          <PropertyPreviewValue choice={preview.choice} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function BoardPropertiesDialog({
  board,
  open,
  onClose,
}: {
  board: Board;
  open: boolean;
  onClose: () => void;
}) {
  const updateBoardColumns = useWorkspaceStore((state) => state.updateBoardColumns);
  const updateTask = useWorkspaceStore((state) => state.updateTask);
  const tasks = useWorkspaceStore((state) => state.tasks[board.id] ?? EMPTY);

  const [columns, setColumns] = useState<Column[]>([]);
  const [adding, setAdding] = useState(false);
  const [editingColor, setEditingColor] = useState<string | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<{ id: string; after: boolean } | null>(null);
  const [dragOption, setDragOption] = useState<{ columnId: string; optionId: string } | null>(null);
  const [overOption, setOverOption] = useState<{ columnId: string; optionId: string; after: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const previewTimer = useRef<number | null>(null);

  const clearPreview = () => {
    if (previewTimer.current !== null) {
      window.clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
    setPreview(null);
  };

  const showPreview = (choice: TypeChoice, element: HTMLElement, delay = 120) => {
    clearPreview();
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      const rect = element.getBoundingClientRect();
      const width = 286;
      const height = 200;
      const left = rect.right + 10 + width <= window.innerWidth - 12
        ? rect.right + 10
        : Math.max(12, rect.left - width - 10);
      const top = Math.max(
        12,
        Math.min(
          rect.top + rect.height / 2 - height / 2,
          window.innerHeight - height - 12,
        ),
      );
      setPreview({ choice, top, left });
    }, delay);
  };

  useEffect(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [preview]);

  useEffect(() => {
    if (!adding) clearPreview();
    // The preview belongs to the add panel; close it with that panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  useEffect(() => () => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    setColumns(
      board.columns.map((column) => ({
        ...column,
        options: column.options?.map((option) => ({ ...option })),
      })),
    );
    setAdding(false);
    setEditingColor(null);
    setDragColumn(null);
    setOverColumn(null);
    setDragOption(null);
    setOverOption(null);
    setBusy(false);
    setError("");
    // Reset only when the dialog opens or the board changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, board.id]);

  const patch = (id: string, change: Partial<Column>) => {
    setColumns((current) =>
      current.map((column) => (column.id === id ? { ...column, ...change } : column)),
    );
  };

  const dropColumn = (targetId: string, after: boolean) => {
    const source = dragColumn;
    setDragColumn(null);
    setOverColumn(null);
    if (!source || source === targetId) return;
    setColumns((current) => {
      const next = [...current];
      const from = next.findIndex((column) => column.id === source);
      if (from < 0) return current;
      const [item] = next.splice(from, 1);
      let index = next.findIndex((column) => column.id === targetId);
      if (index < 0) index = next.length;
      else if (after) index += 1;
      next.splice(index, 0, item);
      return next;
    });
  };

  const dropOption = (columnId: string, targetId: string, after: boolean) => {
    const source = dragOption;
    setDragOption(null);
    setOverOption(null);
    if (!source || source.columnId !== columnId || source.optionId === targetId) return;
    setColumns((current) =>
      current.map((column) => {
        if (column.id !== columnId || !column.options) return column;
        const options = [...column.options];
        const from = options.findIndex((option) => option.id === source.optionId);
        if (from < 0) return column;
        const [item] = options.splice(from, 1);
        let index = options.findIndex((option) => option.id === targetId);
        if (index < 0) index = options.length;
        else if (after) index += 1;
        options.splice(index, 0, item);
        return { ...column, options };
      }),
    );
  };

  const addProperty = (choice: TypeChoice) => {
    clearPreview();
    const used = new Set(columns.map((column) => column.type));
    if (choice.type === "status" && used.has("status")) {
      setError("A board can have one status property. Edit the existing one instead.");
      return;
    }
    if (choice.type === "person" && used.has("person")) {
      setError("A board can have one assignee property.");
      return;
    }
    const options = choice.options
      ? choice.options.map((label) => ({ id: newId("opt"), label }))
      : defaultOptions(choice.type);
    setColumns((current) => [
      ...current,
      {
        id: newId("col"),
        name: choice.label,
        type: choice.type,
        ...(options ? { options } : {}),
      },
    ]);
    setAdding(false);
    setError("");
  };

  const patchOption = (columnId: string, optionId: string, change: Partial<ColumnOption>) => {
    setColumns((current) =>
      current.map((column) =>
        column.id === columnId
          ? {
              ...column,
              options: column.options?.map((option) =>
                option.id === optionId ? { ...option, ...change } : option,
              ),
            }
          : column,
      ),
    );
  };

  const save = async () => {
    if (columns.some((column) => !column.name.trim())) {
      setError("Give every property a name.");
      return;
    }
    const cleaned = columns.map((column) => ({
      ...column,
      name: column.name.trim(),
      ...(column.options
        ? {
            options: column.options
              .filter((option) => option.label.trim())
              .map((option) => ({ ...option, label: option.label.trim() })),
          }
        : {}),
    }));
    if (cleaned.some((column) => HAS_OPTIONS(column.type) && !(column.options?.length ?? 0))) {
      setError("Choice properties need at least one option.");
      return;
    }

    const oldStatus = board.columns.find((column) => column.type === "status");
    const newStatus = cleaned.find((column) => column.type === "status");
    const removed = (oldStatus?.options ?? []).filter(
      (option) => !newStatus?.options?.some((next) => next.id === option.id),
    );
    const fallback = newStatus?.options?.[0]?.id;

    setBusy(true);
    setError("");
    const saved = await updateBoardColumns(board.id, cleaned);
    if (!saved) {
      setBusy(false);
      setError("Could not save the properties. Try again.");
      return;
    }
    if (removed.length && fallback) {
      const stranded = tasks.filter((task) => removed.some((option) => option.id === task.status));
      await Promise.all(stranded.map((task) => updateTask(task.id, { status: fallback })));
    }
    setBusy(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      title="Properties"
      description="Shape the board around what you track. Add, rename, reorder or hide any property."
      width={720}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save properties"}
          </button>
        </>
      }
    >
      <div className="ws-props-editor">
        {columns.length === 0 ? (
          <p className="ws-props-empty">This board has only a title. Add the first property below.</p>
        ) : null}
        <div className="ws-props-list">
          {columns.map((column, index) => {
            const hasOptions = HAS_OPTIONS(column.type);
            return (
              <div
                className="ws-prop-card"
                key={column.id}
                data-hidden={column.hidden}
                data-dragging={dragColumn === column.id}
                data-over={
                  dragColumn && dragColumn !== column.id && overColumn?.id === column.id
                    ? overColumn.after
                      ? "after"
                      : "before"
                    : undefined
                }
                onDragOver={(event) => {
                  if (!dragColumn || dragColumn === column.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  const after = event.clientY > rect.top + rect.height / 2;
                  if (overColumn?.id !== column.id || overColumn.after !== after) {
                    setOverColumn({ id: column.id, after });
                  }
                }}
                onDrop={(event) => {
                  if (!dragColumn) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  dropColumn(column.id, event.clientY > rect.top + rect.height / 2);
                }}
              >
                <div className="ws-prop-row">
                  <span
                    className="ws-prop-grip"
                    draggable
                    role="button"
                    tabIndex={0}
                    title="Drag to reorder"
                    aria-label={`Reorder ${column.name}`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", column.id);
                      const card = event.currentTarget.closest<HTMLElement>(".ws-prop-card");
                      if (card) {
                        const rect = card.getBoundingClientRect();
                        event.dataTransfer.setDragImage(
                          card,
                          event.clientX - rect.left,
                          event.clientY - rect.top,
                        );
                      }
                      setDragOption(null);
                      setOverOption(null);
                      setDragColumn(column.id);
                      setOverColumn(null);
                    }}
                    onDragEnd={() => {
                      setDragColumn(null);
                      setOverColumn(null);
                    }}
                  >
                    <GripVertical />
                  </span>
                  <span
                    className="ws-prop-type-icon"
                    data-type={column.type}
                    title={TYPE_LABEL[column.type]}
                    aria-hidden="true"
                  >
                    <PropertyTypeIcon type={column.type} />
                  </span>
                  <input
                    className="text-input"
                    value={column.name}
                    maxLength={40}
                    aria-label={`Property ${index + 1} name`}
                    onChange={(event) => patch(column.id, { name: event.target.value })}
                  />
                  <span className="ws-prop-type">{TYPE_LABEL[column.type]}</span>
                  <button
                    type="button"
                    className="ws-prop-icon-btn"
                    title={column.hidden ? "Show property" : "Hide property"}
                    aria-label={column.hidden ? `Show ${column.name}` : `Hide ${column.name}`}
                    onClick={() => patch(column.id, { hidden: !column.hidden })}
                  >
                    {column.hidden ? <EyeOff /> : <Eye />}
                  </button>
                  <button
                    type="button"
                    className="ws-prop-icon-btn ws-prop-remove"
                    title="Remove property"
                    aria-label={`Remove ${column.name}`}
                    onClick={() => setColumns((current) => current.filter((item) => item.id !== column.id))}
                  >
                    <Trash2 />
                  </button>
                </div>

                {hasOptions ? (
                  <div className="ws-prop-options">
                    {(column.options ?? []).map((option, optionIndex) => (
                      <div className="ws-prop-option-item" key={option.id}>
                        <div
                          className="ws-prop-option"
                          data-dragging={
                            dragOption?.columnId === column.id && dragOption.optionId === option.id
                          }
                          data-over={
                            overOption?.columnId === column.id &&
                            overOption.optionId === option.id &&
                            dragOption?.optionId !== option.id
                              ? overOption.after
                                ? "after"
                                : "before"
                              : undefined
                          }
                          onDragOver={(event) => {
                            if (!dragOption || dragOption.columnId !== column.id || dragOption.optionId === option.id) {
                              return;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            event.dataTransfer.dropEffect = "move";
                            const rect = event.currentTarget.getBoundingClientRect();
                            const after = event.clientY > rect.top + rect.height / 2;
                            if (
                              overOption?.columnId !== column.id ||
                              overOption.optionId !== option.id ||
                              overOption.after !== after
                            ) {
                              setOverOption({ columnId: column.id, optionId: option.id, after });
                            }
                          }}
                          onDrop={(event) => {
                            if (!dragOption || dragOption.columnId !== column.id) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const rect = event.currentTarget.getBoundingClientRect();
                            dropOption(
                              column.id,
                              option.id,
                              event.clientY > rect.top + rect.height / 2,
                            );
                          }}
                        >
                          <span
                            className="ws-prop-grip ws-prop-option-grip"
                            draggable
                            role="button"
                            tabIndex={0}
                            title="Drag to reorder"
                            aria-label={`Reorder ${option.label}`}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", option.id);
                              const row = event.currentTarget.closest<HTMLElement>(".ws-prop-option");
                              if (row) {
                                const rect = row.getBoundingClientRect();
                                event.dataTransfer.setDragImage(
                                  row,
                                  event.clientX - rect.left,
                                  event.clientY - rect.top,
                                );
                              }
                              setDragColumn(null);
                              setOverColumn(null);
                              setDragOption({ columnId: column.id, optionId: option.id });
                              setOverOption(null);
                            }}
                            onDragEnd={() => {
                              setDragOption(null);
                              setOverOption(null);
                            }}
                          >
                            <GripVertical />
                          </span>
                          {column.type === "status" ? (
                            <button
                              type="button"
                              className="ws-prop-option-dot"
                              data-color={option.color ?? statusColor(option.label)}
                              title="Change color"
                              aria-label={`Color for ${option.label}`}
                              onClick={() =>
                                setEditingColor((current) =>
                                  current === option.id ? null : option.id,
                                )
                              }
                            />
                          ) : null}
                          <input
                            className="text-input"
                            value={option.label}
                            maxLength={40}
                            aria-label={`${column.name} option ${optionIndex + 1}`}
                            onChange={(event) =>
                              patchOption(column.id, option.id, { label: event.target.value })
                            }
                          />
                          <button
                            type="button"
                            className="ws-prop-icon-btn ws-prop-remove"
                            title="Remove option"
                            onClick={() =>
                              patch(column.id, {
                                options: column.options?.filter((item) => item.id !== option.id),
                              })
                            }
                          >
                            <Trash2 />
                          </button>
                        </div>
                        {editingColor === option.id ? (
                          <div className="ws-status-colors" role="group" aria-label={`Color for ${option.label}`}>
                            {STATUS_COLORS.map((swatch) => (
                              <button
                                key={swatch.id}
                                type="button"
                                className="ws-status-swatch"
                                data-color={swatch.id}
                                data-active={(option.color ?? statusColor(option.label)) === swatch.id}
                                title={swatch.label}
                                aria-label={swatch.label}
                                onClick={() => {
                                  patchOption(column.id, option.id, { color: swatch.id });
                                  setEditingColor(null);
                                }}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="ws-prop-add-option"
                      onClick={() =>
                        patch(column.id, {
                          options: [
                            ...(column.options ?? []),
                            {
                              id: newId("opt"),
                              label: "New option",
                              ...(column.type === "status" ? { color: "slate" as const } : {}),
                            },
                          ],
                        })
                      }
                    >
                      <Plus /> Add option
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {adding ? (
          <div className="ws-prop-types">
            {TYPE_GROUPS.map((group) => (
              <div className="ws-prop-type-group" key={group.label}>
                <h3>{group.label}</h3>
                <div className="ws-prop-type-grid">
                  {group.choices.map((choice) => (
                    <button
                      key={`${group.label}:${choice.label}`}
                      type="button"
                      onClick={() => addProperty(choice)}
                      onMouseEnter={(event) => showPreview(choice, event.currentTarget)}
                      onMouseLeave={clearPreview}
                      onFocus={(event) => showPreview(choice, event.currentTarget, 0)}
                      onBlur={clearPreview}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button type="button" className="ws-prop-cancel-add" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="ws-prop-add" onClick={() => setAdding(true)}>
            <Plus /> Add property
          </button>
        )}

        {error ? <p className="ws-props-error" role="alert">{error}</p> : null}
      </div>
      {preview ? <PropertyTypePreview preview={preview} /> : null}
    </Dialog>
  );
}
