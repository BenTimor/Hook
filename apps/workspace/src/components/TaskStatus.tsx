import type { Column, ColumnOption, StatusColor } from "../lib/types";
import { SelectMenu } from "./SelectMenu";

export const STATUS_COLORS: Array<{ id: StatusColor; label: string }> = [
  { id: "slate", label: "Slate" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "amber", label: "Amber" },
  { id: "red", label: "Red" },
  { id: "purple", label: "Purple" },
  { id: "teal", label: "Teal" },
  { id: "pink", label: "Pink" },
];

const DONE = /(done|complete|closed|shipped|merged|resolved|approved)/i;
const BLOCKED = /(block|stuck|failed|cancel|hold)/i;
const ACTIVE = /(progress|doing|review|active|started|working|in dev)/i;
const TODO = /(todo|to do|backlog|planned|open|queued|ready|new)/i;

/** A colour for a status without an explicit one, by what its label means. */
export function statusColor(label: string): StatusColor {
  if (DONE.test(label)) return "green";
  if (BLOCKED.test(label)) return "red";
  if (ACTIVE.test(label)) return "blue";
  if (TODO.test(label)) return "amber";
  return "slate";
}

export function optionColor(option: Pick<ColumnOption, "label" | "color"> | undefined): StatusColor {
  return option?.color ?? statusColor(option?.label ?? "");
}

/** A compact status pill with the same custom menu as every other dropdown. */
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
  const options = (column.options ?? []).map((option) => ({
    id: option.id,
    label: option.label || "Untitled",
    color: optionColor(option),
  }));
  const current = options.find((option) => option.id === value);
  const label = current?.label || "No status";
  const color = current?.color ?? statusColor(label);

  if (readOnly) {
    return (
      <span className="ws-status-pill" data-color={color}>
        <span className="ws-status-dot" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }

  return (
    <SelectMenu
      variant="status"
      color={color}
      value={value}
      options={options}
      label={column.name}
      onChange={onChange}
    />
  );
}
