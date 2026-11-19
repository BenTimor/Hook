import { ChevronDown } from "lucide-react";

import type { Column } from "../lib/types";

export type StatusTone = "done" | "active" | "blocked" | "todo" | "neutral";

const DONE = /(done|complete|closed|shipped|merged|resolved|approved)/i;
const BLOCKED = /(block|stuck|failed|cancel|hold)/i;
const ACTIVE = /(progress|doing|review|active|started|working|in dev)/i;
const TODO = /(todo|to do|backlog|planned|open|queued|ready|new)/i;

/** Colours by what a status means, not by its position on this board. */
export function statusTone(label: string): StatusTone {
  if (DONE.test(label)) return "done";
  if (BLOCKED.test(label)) return "blocked";
  if (ACTIVE.test(label)) return "active";
  if (TODO.test(label)) return "todo";
  return "neutral";
}

/** A compact status pill that keeps the native select underneath. */
export function TaskStatus({
  column,
  value,
  readOnly,
  onChange,
}: {
  column: Column;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  const options = column.options ?? [];
  const current = options.find((option) => option.id === value);
  const label = current?.label || "No status";

  if (readOnly) {
    return (
      <span className="ws-status-pill" data-tone={statusTone(label)}>
        <span className="ws-status-dot" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }

  return (
    <label className="ws-status-pill" data-tone={statusTone(label)}>
      <span className="ws-status-dot" aria-hidden="true" />
      <span>{label}</span>
      <ChevronDown className="ws-status-chevron" aria-hidden="true" />
      <select value={value} aria-label={column.name} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label || "Untitled"}
          </option>
        ))}
      </select>
    </label>
  );
}
