import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

import type { ColumnOption } from "../lib/types";

/** A compact multi-select for option-backed properties such as tags. */
export function MultiSelectMenu({
  values,
  options,
  label,
  onChange,
}: {
  values: string[];
  options: ColumnOption[];
  label: string;
  onChange: (next: string[]) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

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
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", () => setOpen(false));
    window.addEventListener("scroll", () => setOpen(false), true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const longest = options.reduce((length, option) => Math.max(length, option.label.length), 0);
    const width = Math.max(rect.width, Math.min(280, Math.max(150, longest * 7.2 + 48)));
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const top = window.innerHeight - rect.bottom < 300 && rect.top > 320
      ? rect.top - 310
      : Math.min(rect.bottom + 7, window.innerHeight - 300);
    setPosition({ top: Math.max(12, top), left, width });
    setOpen(true);
  };

  const selected = options.filter((option) => values.includes(option.id));
  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ws-select-trigger ws-select-cell"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span className="ws-select-value">
          {selected.length ? selected.map((option) => option.label).join(", ") : "—"}
        </span>
        <ChevronDown className="ws-select-chevron" aria-hidden="true" />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menu}
              className="ws-select-menu"
              style={{ top: position.top, left: position.left, width: position.width }}
              role="listbox"
              aria-label={label}
              aria-multiselectable="true"
            >
              {options.map((option) => {
                const active = values.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className="ws-select-option"
                    data-active={active}
                    onClick={() => toggle(option.id)}
                  >
                    {option.color ? (
                      <span className="ws-select-option-dot" data-color={option.color} aria-hidden="true" />
                    ) : null}
                    <span className="ws-select-option-label">{option.label || "Untitled"}</span>
                    <span className="ws-select-check" aria-hidden="true">
                      {active ? <Check /> : null}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
