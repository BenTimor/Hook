import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * A modal with one contract for every product: portal, backdrop, Escape,
 * click-outside, focus moved into the panel and restored on close.
 *
 * The chat app's own sheets predate this and stay where they are; new dialogs
 * (Workspace, and the chat surface when it moves into packages/chat) use this.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 460,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  // The callback is read through a ref so that a parent re-render (a poll, a
  // keystroke) cannot re-run this effect: it used to focus the close button and
  // restore the old focus on every render, which stole the caret from the input.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener("keydown", onKey);
    // The field first, not the header's close button.
    const focusable =
      panel.current?.querySelector<HTMLElement>(
        ".dlg-body input, .dlg-body textarea, .dlg-body select",
      ) ?? panel.current?.querySelector<HTMLElement>("input, textarea, select, button");
    focusable?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      restore.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="dlg-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        ref={panel}
      >
        <header className="dlg-head">
          <div>
            <h2 className="dlg-title">{title}</h2>
            {description ? <p className="dlg-description">{description}</p> : null}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X strokeWidth={1.9} />
          </button>
        </header>
        {children ? <div className="dlg-body">{children}</div> : null}
        {footer ? <div className="dlg-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** A dialog with one text field — the shape most "new thing" flows need. */
export function TextFieldDialog({
  open,
  title,
  description,
  label,
  placeholder,
  value,
  onChange,
  confirm,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  confirm: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!value.trim()}
            onClick={onConfirm}
          >
            {confirm}
          </button>
        </>
      }
    >
      <label className="dlg-field">
        <span>{label}</span>
        <input
          className="text-input"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) onConfirm();
          }}
        />
      </label>
    </Dialog>
  );
}
