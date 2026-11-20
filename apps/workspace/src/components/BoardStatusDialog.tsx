import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Dialog } from "@hook/ui";

import type { Board, ColumnOption, Task } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { STATUS_COLORS, statusColor } from "./TaskStatus";

const EMPTY: Task[] = [];

const newId = (prefix: "opt" | "col") =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function BoardStatusDialog({
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
  const statusColumn = board.columns.find((column) => column.type === "status");

  const [rows, setRows] = useState<ColumnOption[]>([]);
  const [editingColor, setEditingColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const current = statusColumn?.options ?? [];
    setRows(
      (current.length
        ? current
        : [
            { id: newId("opt"), label: "To do", color: statusColor("To do") },
            { id: newId("opt"), label: "Done", color: statusColor("Done") },
          ]
      ).map((option) => ({ ...option, color: option.color ?? statusColor(option.label) })),
    );
    setEditingColor(null);
    setError("");
    setBusy(false);
    // Reset only when the dialog opens or another board is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, board.id]);

  const move = (index: number, step: number) => {
    setRows((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (!item) return current;
      next.splice(index + step, 0, item);
      return next;
    });
  };

  const save = async () => {
    if (rows.some((row) => !row.label.trim())) {
      setError("Give every status a name.");
      return;
    }
    const cleaned = rows.map((row) => ({
      id: row.id,
      label: row.label.trim(),
      color: row.color ?? statusColor(row.label),
    }));
    if (cleaned.length === 0) {
      setError("Keep at least one status.");
      return;
    }
    const lower = cleaned.map((row) => row.label.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      setError("Status names need to be different.");
      return;
    }

    const removed = (statusColumn?.options ?? []).filter(
      (option) => !cleaned.some((row) => row.id === option.id),
    );
    const columns = statusColumn
      ? board.columns.map((column) =>
          column.id === statusColumn.id ? { ...column, options: cleaned } : column,
        )
      : [...board.columns, { id: newId("col"), name: "Status", type: "status" as const, options: cleaned }];

    setBusy(true);
    setError("");
    const saved = await updateBoardColumns(board.id, columns);
    if (!saved) {
      setBusy(false);
      setError("Could not save the statuses. Try again.");
      return;
    }

    // A removed status must not strand its tasks in the "Other" column.
    const fallback = cleaned[0].id;
    const stranded = tasks.filter((task) => removed.some((option) => option.id === task.status));
    await Promise.all(stranded.map((task) => updateTask(task.id, { status: fallback })));
    setBusy(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      title="Statuses"
      description="Shape the board's workflow. Removing a status moves its tasks to the first one."
      width={460}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save statuses"}
          </button>
        </>
      }
    >
      <div className="ws-status-editor">
        <div className="ws-status-rows">
          {rows.map((row, index) => {
            const color = row.color ?? statusColor(row.label);
            return (
              <div className="ws-status-item" key={row.id}>
                <div className="ws-status-row">
                  <button
                    type="button"
                    className="ws-status-row-dot"
                    data-color={color}
                    data-active={editingColor === row.id}
                    title="Change color"
                    aria-label={`Color for ${row.label}`}
                    onClick={() => setEditingColor((current) => (current === row.id ? null : row.id))}
                  />
                  <input
                    className="text-input"
                    value={row.label}
                    maxLength={40}
                    aria-label={`Status ${index + 1}`}
                    onChange={(event) =>
                      setRows((current) =>
                        current.map((item) =>
                          item.id === row.id
                            ? { ...item, label: event.target.value, color }
                            : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="ws-status-row-btn"
                    title="Move up"
                    aria-label={`Move ${row.label} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="ws-status-row-btn"
                    title="Move down"
                    aria-label={`Move ${row.label} down`}
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="ws-status-row-btn ws-status-row-remove"
                    title="Remove status"
                    aria-label={`Remove ${row.label}`}
                    disabled={rows.length === 1}
                    onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
                {editingColor === row.id ? (
                  <div className="ws-status-colors" role="group" aria-label={`Color for ${row.label}`}>
                    {STATUS_COLORS.map((swatch) => (
                      <button
                        key={swatch.id}
                        type="button"
                        className="ws-status-swatch"
                        data-color={swatch.id}
                        data-active={color === swatch.id}
                        title={swatch.label}
                        aria-label={swatch.label}
                        onClick={() => {
                          setRows((current) =>
                            current.map((item) =>
                              item.id === row.id ? { ...item, color: swatch.id } : item,
                            ),
                          );
                          setEditingColor(null);
                        }}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          className="ws-status-add"
          onClick={() =>
            setRows((current) => [
              ...current,
              {
                id: newId("opt"),
                label: "New status",
                color: STATUS_COLORS[current.length % STATUS_COLORS.length].id,
              },
            ])
          }
        >
          <Plus aria-hidden="true" />
          Add status
        </button>

        {error ? <p className="ws-status-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
