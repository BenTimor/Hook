import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  id: string;
  label: string;
}

/**
 * One rounded dropdown used everywhere in Workspace.
 *
 * The trigger keeps the app's own look while the list is a portal, so it never
 * inherits the square, system-drawn menu of a native `<select>`. Arrow keys,
 * Home/End, Enter, Escape and Tab work the way they do in a listbox.
 */
export function SelectMenu({
  value,
  options,
  onChange,
  label,
  variant = "field",
  className = "",
  disabled = false,
  tone,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  variant?: "field" | "cell" | "status";
  className?: string;
  disabled?: boolean;
  tone?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const current = options.find((option) => option.id === value);
  const currentLabel = current?.label || (variant === "status" ? "No status" : "Select an option");

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

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const selected = menu.current?.querySelector<HTMLButtonElement>(".ws-select-option[data-active='true']");
      const first = menu.current?.querySelector<HTMLButtonElement>(".ws-select-option");
      (selected ?? first)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const show = () => {
    if (disabled) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const longest = options.reduce(
      (length, option) => Math.max(length, (option.label || "Untitled").length),
      0,
    );
    const contentWidth = Math.min(280, Math.max(116, longest * 7.2 + 52));
    const width = Math.max(rect.width, contentWidth);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const top = window.innerHeight - rect.bottom < 300 && rect.top > 320
      ? rect.top - 310
      : Math.min(rect.bottom + 7, window.innerHeight - 300);
    setPosition({ top: Math.max(12, top), left, width });
    setOpen(true);
  };

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  };

  const move = (step: number) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>(".ws-select-option") ?? []);
    if (items.length === 0) return;
    const active = document.activeElement;
    const index = items.findIndex((item) => item === active);
    const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    items[next]?.focus();
  };

  if (variant === "status") {
    return (
      <>
        <button
          ref={trigger}
          type="button"
          className={`ws-status-pill${className ? ` ${className}` : ""}`}
          data-tone={tone}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : show())}
          onKeyDown={(event) => {
            if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
            event.preventDefault();
            show();
          }}
        >
          <span className="ws-status-dot" aria-hidden="true" />
          <span>{currentLabel}</span>
          <ChevronDown className="ws-status-chevron" aria-hidden="true" />
        </button>
        {open && position ? menuView() : null}
      </>
    );
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`ws-select-trigger ws-select-${variant}${className ? ` ${className}` : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          show();
        }}
      >
        <span className="ws-select-value">{currentLabel}</span>
        <ChevronDown className="ws-select-chevron" aria-hidden="true" />
      </button>
      {open && position ? menuView() : null}
    </>
  );

  function menuView() {
    return createPortal(
      <div
        ref={menu}
        className="ws-select-menu"
        style={{ top: position!.top, left: position!.left, width: position!.width }}
        role="listbox"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            menu.current?.querySelector<HTMLButtonElement>(".ws-select-option")?.focus();
          } else if (event.key === "End") {
            event.preventDefault();
            const items = menu.current?.querySelectorAll<HTMLButtonElement>(".ws-select-option");
            items?.[items.length - 1]?.focus();
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
      >
        {options.length === 0 ? <p className="ws-select-empty">No options yet.</p> : null}
        {options.map((option) => {
          const active = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={active}
              className="ws-select-option"
              data-active={active}
              onClick={() => choose(option.id)}
            >
              <span className="ws-select-option-label">{option.label || "Untitled"}</span>
              <span className="ws-select-check" aria-hidden="true">
                {active ? <Check /> : null}
              </span>
            </button>
          );
        })}
      </div>,
      document.body,
    );
  }
}
