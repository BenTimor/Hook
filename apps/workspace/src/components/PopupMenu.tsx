import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuEntry =
  | {
      kind: "action";
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      /** A tick in front of the row: which folder an item is already in. */
      checked?: boolean;
      /** Extra left padding, used to show a folder's place in the tree. */
      indent?: number;
      onSelect: () => void;
    }
  | { kind: "heading"; label: string }
  | { kind: "separator" };

/**
 * A menu that opens where the pointer is (right click) or under a button.
 *
 * It lives in a portal so a scrolling pane cannot clip it, and it clamps itself
 * into the window so a row at the bottom of the tree still gets a usable menu.
 */
export function PopupMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(6, Math.min(y, window.innerHeight - height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const el = ref.current;
      if (el && event.target instanceof Node && el.contains(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="ws-menu ws-popup"
      role="menu"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
    >
      {entries.map((entry, index) => {
        if (entry.kind === "separator") {
          return <div className="ws-menu-sep" key={`sep-${index}`} />;
        }
        if (entry.kind === "heading") {
          return (
            <div className="ws-menu-label" key={`head-${index}`}>
              {entry.label}
            </div>
          );
        }
        return (
          <button
            key={entry.label + index}
            role="menuitem"
            type="button"
            className={entry.danger ? "ws-menu-danger" : undefined}
            data-active={entry.checked ?? undefined}
            disabled={entry.disabled}
            style={entry.indent ? { paddingLeft: 14 + entry.indent * 12 } : undefined}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.checked ? (
              <span className="ws-menu-tick" aria-hidden="true">
                ✓
              </span>
            ) : entry.icon ? (
              <span className="ws-menu-icon" aria-hidden="true">
                {entry.icon}
              </span>
            ) : null}
            <span className="ws-menu-text">{entry.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
