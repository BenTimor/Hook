import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  const move = (index: number, step: number) => {
    setColumns((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (!item) return current;
      next.splice(index + step, 0, item);
      return next;
    });
  };

  const addProperty = (choice: TypeChoice) => {
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

  const moveOption = (columnId: string, index: number, step: number) => {
    setColumns((current) =>
      current.map((column) => {
        if (column.id !== columnId || !column.options) return column;
        const options = [...column.options];
        const [item] = options.splice(index, 1);
        if (!item) return column;
        options.splice(index + step, 0, item);
        return { ...column, options };
      }),
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
              <div className="ws-prop-card" key={column.id} data-hidden={column.hidden}>
                <div className="ws-prop-row">
                  <button
                    type="button"
                    className="ws-prop-icon-btn"
                    title={column.hidden ? "Show property" : "Hide property"}
                    aria-label={column.hidden ? `Show ${column.name}` : `Hide ${column.name}`}
                    onClick={() => patch(column.id, { hidden: !column.hidden })}
                  >
                    {column.hidden ? <EyeOff /> : <Eye />}
                  </button>
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
                    title="Move up"
                    aria-label={`Move ${column.name} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </button>
                  <button
                    type="button"
                    className="ws-prop-icon-btn"
                    title="Move down"
                    aria-label={`Move ${column.name} down`}
                    disabled={index === columns.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
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
                        <div className="ws-prop-option">
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
                            className="ws-prop-icon-btn"
                            title="Move option up"
                            disabled={optionIndex === 0}
                            onClick={() => moveOption(column.id, optionIndex, -1)}
                          >
                            <ArrowUp />
                          </button>
                          <button
                            type="button"
                            className="ws-prop-icon-btn"
                            title="Move option down"
                            disabled={optionIndex === (column.options?.length ?? 0) - 1}
                            onClick={() => moveOption(column.id, optionIndex, 1)}
                          >
                            <ArrowDown />
                          </button>
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
    </Dialog>
  );
}
