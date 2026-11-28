import type {
  Board,
  BoardFilterRule,
  BoardView,
  Column,
  Task,
} from "./types";

/**
 * A board's saved presets and the rules behind them, in one place.
 *
 * The window filters here; the agent tools filter the same rules on the Rust
 * side (`crates/hook-core/src/workspace.rs`), so both sides read the shape
 * written in `types.ts` and `docs/workspace.md`. A rule is one column, one
 * operator and a value; rules combine with "and", values inside one rule with
 * "or". The task title is a filterable field even though it is not a column,
 * and it is the only free text search: a description is a document, not a row.
 */
export const TITLE_FIELD = "title";

export const TEXT_TYPES = new Set([
  "text",
  "longtext",
  "url",
  "email",
  "phone",
]);

export function newRuleId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `fl_${Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 16)}`;
}

export function newViewId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `vw_${Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 16)}`;
}

export function boardViews(board: Board): BoardView[] {
  return board.views ?? [];
}

export function activeView(board: Board, id: string | null): BoardView | null {
  if (!id) return null;
  return boardViews(board).find((view) => view.id === id) ?? null;
}

/** The columns a view shows. No list means "all of them", the happy path. */
export function hiddenColumnIds(board: Board, view: BoardView | null): Set<string> {
  if (view) return new Set(view.hiddenColumns ?? []);
  return new Set(board.columns.filter((column) => column.hidden).map((column) => column.id));
}

/** A board whose columns carry the hidden state the current view gives them. */
export function boardAsShown(board: Board, hidden: Set<string>): Board {
  return {
    ...board,
    columns: board.columns.map((column) =>
      hidden.has(column.id) ? { ...column, hidden: true } : { ...column, hidden: false },
    ),
  };
}

export function ruleValues(rule: BoardFilterRule): string[] {
  if (rule.value === undefined) return [];
  return Array.isArray(rule.value) ? rule.value : [rule.value];
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** The value a rule looks at, already flattened to what its operator wants. */
function rawValue(task: Task, column: Column | null): unknown {
  if (!column) return task.title;
  if (column.type === "status") return task.status;
  if (column.type === "person") {
    return task.assignees?.length ? task.assignees : task.assignee ? [task.assignee] : [];
  }
  if (column.type === "checkbox") return task.fields?.[column.id] === true;
  const raw = task.fields?.[column.id];
  if (column.type === "daterange" && raw && typeof raw === "object") {
    const range = raw as { start?: unknown; end?: unknown };
    return {
      start: normalize(range.start),
      end: normalize(range.end),
    };
  }
  return raw;
}

function valueStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(normalize).filter(Boolean);
  if (raw && typeof raw === "object") {
    const range = raw as { start?: string; end?: string };
    return [range.start, range.end].filter((value): value is string => Boolean(value));
  }
  const value = normalize(raw);
  return value ? [value] : [];
}

function isEmpty(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  if (raw && typeof raw === "object") {
    const range = raw as { start?: string; end?: string };
    return !range.start && !range.end;
  }
  return false;
}

function equalsAny(raw: unknown, values: string[]): boolean {
  if (Array.isArray(raw)) {
    const items = raw.map(normalize).map((value) => value.toLowerCase());
    return values.some((value) => items.includes(value.trim().toLowerCase()));
  }
  if (raw && typeof raw === "object") {
    const range = raw as { start?: string; end?: string };
    const start = normalize(range.start).toLowerCase();
    return values.some((value) => value.trim().toLowerCase() === start);
  }
  const item = normalize(raw).trim().toLowerCase();
  if (!item) return false;
  return values.some((value) => value.trim().toLowerCase() === item);
}

function comparable(raw: unknown): string | number | null {
  if (raw && typeof raw === "object") {
    const range = raw as { start?: string; end?: string };
    return range.start || range.end || null;
  }
  if (Array.isArray(raw)) return null;
  if (typeof raw === "number" || typeof raw === "boolean") return Number(raw);
  const text = normalize(raw).trim();
  return text || null;
}

/**
 * True when one rule keeps the task. An unknown column is ignored rather than
 * hiding everything: a column removed while its rule was still on screen must
 * not empty the board.
 */
export function ruleMatches(
  task: Task,
  columns: Column[],
  rule: BoardFilterRule,
): boolean {
  if (!rule.field) return true;
  const column =
    rule.field === TITLE_FIELD
      ? null
      : (columns.find((candidate) => candidate.id === rule.field) ?? null);
  if (rule.field !== TITLE_FIELD && !column) return true;
  const raw = rawValue(task, column);
  const values = ruleValues(rule);
  if (rule.op === "empty") return isEmpty(raw);
  if (rule.op === "not_empty") return !isEmpty(raw);
  if (values.length === 0) return true;
  switch (rule.op) {
    case "is":
      return equalsAny(raw, values);
    case "is_not":
      return !equalsAny(raw, values);
    case "contains": {
      const haystack = (Array.isArray(raw) ? raw.map(normalize) : valueStrings(raw))
        .join(" ")
        .toLowerCase();
      return values.some((value) => haystack.includes(value.trim().toLowerCase()));
    }
    case "not_contains": {
      const haystack = (Array.isArray(raw) ? raw.map(normalize) : valueStrings(raw))
        .join(" ")
        .toLowerCase();
      return !values.some((value) => haystack.includes(value.trim().toLowerCase()));
    }
    case "gt":
    case "lt": {
      const left = comparable(raw);
      if (left === null) return false;
      return values.some((value) => {
        const right = value.trim();
        const leftNumber = typeof left === "number" ? left : Number(left);
        const rightNumber = Number(right);
        const bothNumeric =
          Number.isFinite(leftNumber) &&
          Number.isFinite(rightNumber) &&
          right !== "" &&
          String(left).trim() !== "";
        if (bothNumeric) return rule.op === "gt" ? leftNumber > rightNumber : leftNumber < rightNumber;
        return rule.op === "gt" ? String(left) > right : String(left) < right;
      });
    }
    default:
      return true;
  }
}

export function filterTasks(tasks: Task[], columns: Column[], rules: BoardFilterRule[]): Task[] {
  const active = rules.filter(
    (rule) => rule.op === "empty" || rule.op === "not_empty" || ruleValues(rule).length > 0,
  );
  if (active.length === 0) return tasks;
  return tasks.filter((task) => active.every((rule) => ruleMatches(task, columns, rule)));
}

/**
 * The values a filtered view implies for a task created inside it. Status and
 * option values are seeded so a new card does not vanish from the view the
 * moment it is made; a title search cannot be seeded and is the one exception.
 */
export function seedFromFilters(
  board: Board,
  rules: BoardFilterRule[],
): { status?: string; fields: Record<string, unknown> } {
  let status: string | undefined;
  const fields: Record<string, unknown> = {};
  for (const rule of rules) {
    if (rule.op !== "is") continue;
    const values = ruleValues(rule);
    if (values.length === 0) continue;
    const column = board.columns.find((candidate) => candidate.id === rule.field);
    if (!column) continue;
    if (column.type === "status") status = values[0];
    else if (column.type === "select") fields[column.id] = values[0];
    else if (column.type === "multiselect") fields[column.id] = values;
    else if (column.type === "checkbox") fields[column.id] = values[0] === "true";
  }
  return { status, fields };
}

/** The rules with the title search first, which is how the menu reads them. */
export function orderedRules(rules: BoardFilterRule[]): BoardFilterRule[] {
  return [...rules].sort((left, right) => {
    if (left.field === TITLE_FIELD && right.field !== TITLE_FIELD) return -1;
    if (right.field === TITLE_FIELD && left.field !== TITLE_FIELD) return 1;
    return 0;
  });
}

export function titleRule(rules: BoardFilterRule[]): BoardFilterRule | undefined {
  return rules.find((rule) => rule.field === TITLE_FIELD && rule.op === "contains");
}
