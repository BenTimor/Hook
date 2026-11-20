import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Filter } from "lucide-react";

import type { Board } from "../lib/types";
import { optionColor } from "./TaskStatus";

export type BoardFilters = Record<string, string[]>;

/**
 * Filter a board by its status and select columns.
 *
 * A column with nothing selected is ignored; picking two values in the same
 * column means "either", while different columns combine with "and" - so
 * "Status: To do" plus "Priority: High" is exactly the intersection.
 */
export function BoardFilter({
  board,
  filters,
  onChange,
}: {
  board: Board;
  filters: BoardFilters;
  onChange: (next: BoardFilters) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const groups = board.columns.filter(
    (column) => (column.type === "status" || column.type === "select") && (column.options?.length ?? 0) > 0,
  );
  const activeCount = Object.values(filters).reduce((count, values) => count + values.length, 0);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const reposition = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && menu.current?.contains(event.target)) return;
      setOpen(false);
    };
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
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 270;
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const top = window.innerHeight - rect.bottom < 380 && rect.top > 400
      ? rect.top - 390
      : Math.min(rect.bottom + 8, window.innerHeight - 380);
    setPosition({ top: Math.max(12, top), left });
    setOpen(true);
  };

  const toggle = (columnId: string, value: string) => {
    const current = filters[columnId] ?? [];
    const values = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    const next = { ...filters };
    if (values.length) next[columnId] = values;
    else delete next[columnId];
    onChange(next);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost ws-filter-trigger"
        data-active={activeCount > 0}
        aria-label="Filter tasks"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          show();
        }}
      >
        <Filter />
        Filter
        {activeCount > 0 ? <span className="ws-filter-count">{activeCount}</span> : null}
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menu}
              className="ws-filter-menu"
              style={{ top: position.top, left: position.left }}
              role="dialog"
              aria-label="Filter tasks"
            >
              {groups.length === 0 ? <p className="ws-select-empty">This board has no filterable columns.</p> : null}
              {groups.map((column) => (
                <section className="ws-filter-section" key={column.id}>
                  <h3>{column.name}</h3>
                  {(column.options ?? []).map((option) => {
                    const active = (filters[column.id] ?? []).includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className="ws-filter-option"
                        data-active={active}
                        aria-pressed={active}
                        onClick={() => toggle(column.id, option.id)}
                      >
                        {column.type === "status" ? (
                          <span
                            className="ws-select-option-dot"
                            data-color={optionColor(option)}
                            aria-hidden="true"
                          />
                        ) : null}
                        <span className="ws-filter-option-label">{option.label || "Untitled"}</span>
                        <span className="ws-filter-check" aria-hidden="true">
                          {active ? <Check /> : null}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))}
              <div className="ws-filter-foot">
                <button type="button" onClick={() => onChange({})}>Clear all</button>
                <span>{activeCount ? `${activeCount} selected` : "No filters"}</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
