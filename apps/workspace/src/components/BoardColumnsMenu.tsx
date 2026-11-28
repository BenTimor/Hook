import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Columns3 } from "lucide-react";

import type { Board } from "../lib/types";

/**
 * Which properties the board shows. On a saved view this is the view's own
 * list, so "only my columns" travels with the filter it belongs to; on
 * "All tasks" it is the board's shared default, the same `hidden` flag the
 * properties dialog edits.
 */
export function BoardColumnsMenu({
  board,
  hidden,
  onChange,
  disabled = false,
  scope = "view",
}: {
  board: Board;
  hidden: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  /** Where the choice lives: a saved view, or the board's shared default. */
  scope?: "view" | "board";
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const hiddenCount = board.columns.filter((column) => hidden.has(column.id)).length;

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
    if (disabled) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 260;
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const top = window.innerHeight - rect.bottom < 340 && rect.top > 360
      ? rect.top - 350
      : Math.min(rect.bottom + 8, window.innerHeight - 340);
    setPosition({ top: Math.max(12, top), left });
    setOpen(true);
  };

  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost ws-columns-trigger"
        data-active={hiddenCount > 0}
        aria-label="Show or hide columns"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <Columns3 aria-hidden="true" />
        Columns
        {hiddenCount > 0 ? <span className="ws-filter-count">{hiddenCount}</span> : null}
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menu}
              className="ws-columns-menu"
              style={{ top: position.top, left: position.left }}
              role="dialog"
              aria-label="Show or hide columns"
            >
              <div className="ws-view-menu-head">
                <span>Columns</span>
                <span className="ws-view-menu-hint">
                  {scope === "view" ? "Saved with this view" : "Saved for the board"}
                </span>
              </div>
              <div className="ws-columns-list">
                {board.columns.map((column) => {
                  const visible = !hidden.has(column.id);
                  return (
                    <button
                      key={column.id}
                      type="button"
                      className="ws-columns-row"
                      data-active={visible}
                      aria-pressed={visible}
                      onClick={() => toggle(column.id)}
                    >
                      <span className="ws-columns-box" aria-hidden="true">
                        {visible ? <Check /> : null}
                      </span>
                      <span className="ws-columns-name">{column.name}</span>
                      <span className="ws-columns-type">{typeLabel(column.type)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="ws-filter-foot">
                <button type="button" onClick={() => onChange(new Set())} disabled={hiddenCount === 0}>
                  Show all
                </button>
                <span>{hiddenCount === 0 ? "All visible" : `${hiddenCount} hidden`}</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function typeLabel(type: string): string {
  switch (type) {
    case "status":
      return "Status";
    case "person":
      return "Person";
    case "date":
    case "datetime":
    case "daterange":
      return "Date";
    case "select":
    case "multiselect":
      return "Option";
    case "checkbox":
      return "Check";
    case "number":
    case "progress":
      return "Number";
    default:
      return "Text";
  }
}
