import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Plus, Search, X } from "lucide-react";

import type { Invite, Member } from "../lib/types";
import { assigneeLabel } from "../lib/people";

/** A stable colour and readable initials, without storing an avatar image. */
function avatarTone(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return (hash % 5) + 1;
}

export function personInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] ?? "" : "";
  return `${first}${last}`.toUpperCase() || "?";
}

export function PersonAvatar({
  label,
  value,
  small = false,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <span
      className={`ws-avatar ws-avatar-tone-${avatarTone(value)}${small ? " ws-avatar-sm" : ""}`}
      title={label}
      aria-hidden="true"
    >
      {personInitials(label)}
    </span>
  );
}

interface PersonOption {
  value: string;
  label: string;
  detail?: string;
}

function sameValue(left: string, right: string): boolean {
  if (left === right) return true;
  return left.includes("@") && right.includes("@") && left.toLowerCase() === right.toLowerCase();
}

/**
 * The people on a task.
 *
 * A task can have several assignees. The button opens one checklist rather than
 * a native select, so adding a second person does not replace the first, and a
 * pending invitation stays available by its email address.
 */
export function AssigneesPicker({
  values,
  members,
  invited,
  readOnly = false,
  compact = false,
  label = "Assignees",
  onChange,
}: {
  values: string[];
  members: Member[];
  invited: Invite[];
  readOnly?: boolean;
  compact?: boolean;
  label?: string;
  onChange: (next: string[]) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const [query, setQuery] = useState("");

  const options = useMemo<PersonOption[]>(() => {
    const seen = new Set<string>();
    const list: PersonOption[] = [];
    const add = (option: PersonOption) => {
      const key = option.value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push(option);
    };
    for (const member of members) {
      add({ value: member.subject, label: member.name || member.email || "Member", detail: member.email ?? undefined });
    }
    for (const invite of invited) {
      add({ value: invite.email, label: invite.email, detail: "Invited" });
    }
    for (const value of values) {
      if (seen.has(value.toLowerCase())) continue;
      add({ value, label: assigneeLabel(members, value) });
    }
    return list;
  }, [members, invited, values]);

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
      if (event.type === "scroll" && event.target instanceof Node && menu.current?.contains(event.target)) {
        return;
      }
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
    if (readOnly) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, Math.max(260, rect.width));
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const top = window.innerHeight - rect.bottom < 350 && rect.top > 360
      ? rect.top - 358
      : Math.min(rect.bottom + 8, window.innerHeight - 350);
    setPosition({ top: Math.max(12, top), left, width });
    setQuery("");
    setOpen(true);
  };

  const selected = (value: string) => values.some((entry) => sameValue(entry, value));

  const toggle = (value: string) => {
    onChange(
      selected(value)
        ? values.filter((entry) => !sameValue(entry, value))
        : [...values, value],
    );
  };

  const term = query.trim().toLowerCase();
  const filtered = term
    ? options.filter((option) =>
        `${option.label} ${option.detail ?? ""} ${option.value}`.toLowerCase().includes(term),
      )
    : options;

  if (compact) {
    return (
      <>
        <button
          ref={trigger}
          type="button"
          className="ws-assignee-stack"
          aria-label={values.length ? `${label}: ${values.map((value) => assigneeLabel(members, value)).join(", ")}` : `Assign ${label}`}
          disabled={readOnly}
          onClick={() => (open ? setOpen(false) : show())}
        >
          {values.length ? (
            values.slice(0, 3).map((value) => (
              <PersonAvatar key={value} small value={value} label={assigneeLabel(members, value)} />
            ))
          ) : (
            <span className="ws-assignee-stack-empty">Unassigned</span>
          )}
          {values.length > 3 ? <span className="ws-avatar ws-avatar-sm ws-avatar-more">+{values.length - 3}</span> : null}
        </button>
        {open && position ? menuView() : null}
      </>
    );
  }

  return (
    <div className="ws-assignees">
      <div className="ws-assignee-chips">
        {values.map((value) => {
          const name = assigneeLabel(members, value);
          return (
            <span className="ws-assignee-chip" key={value}>
              <PersonAvatar small value={value} label={name} />
              <span className="ws-assignee-chip-name">{name}</span>
              {!readOnly ? (
                <button
                  type="button"
                  className="ws-assignee-remove"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange(values.filter((entry) => !sameValue(entry, value)))}
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </span>
          );
        })}
        {!readOnly ? (
          <button ref={trigger} type="button" className="ws-assignee-add" onClick={() => (open ? setOpen(false) : show())}>
            <Plus aria-hidden="true" />
            {values.length ? "Add" : "Assign"}
          </button>
        ) : values.length === 0 ? (
          <span className="ws-property-empty">Unassigned</span>
        ) : null}
      </div>
      {open && position ? menuView() : null}
    </div>
  );

  function menuView() {
    return createPortal(
      <div
        ref={menu}
        className="ws-people-menu"
        style={{ top: position!.top, left: position!.left, width: position!.width }}
        role="dialog"
        aria-label={`Choose ${label}`}
      >
        <div className="ws-people-search">
          <Search aria-hidden="true" />
          <input
            autoFocus
            value={query}
            placeholder="Search people"
            aria-label="Search people"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="ws-people-options" role="listbox" aria-multiselectable="true">
          {filtered.length === 0 ? <p className="ws-people-empty">No people match that search.</p> : null}
          {filtered.map((option) => {
            const active = selected(option.value);
            return (
              <button
                key={`${option.value}:${option.label}`}
                type="button"
                role="option"
                aria-selected={active}
                className="ws-people-option"
                data-selected={active}
                onClick={() => toggle(option.value)}
              >
                <PersonAvatar value={option.value} label={option.label} />
                <span className="ws-people-option-text">
                  <strong>{option.label}</strong>
                  {option.detail ? <small>{option.detail}</small> : null}
                </span>
                <span className="ws-people-check">{active ? <Check aria-hidden="true" /> : null}</span>
              </button>
            );
          })}
        </div>
        {values.length > 0 ? (
          <div className="ws-people-menu-foot">
            <button type="button" onClick={() => onChange([])}>Clear all</button>
            <span>{values.length} assigned</span>
          </div>
        ) : null}
      </div>,
      document.body,
    );
  }
}
