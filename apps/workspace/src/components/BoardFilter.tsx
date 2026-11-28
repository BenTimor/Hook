import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, Filter, Plus, Search, X } from "lucide-react";

import type { Board, BoardFilterRule, Column, FilterOp, Invite, Member } from "../lib/types";
import { newRuleId, ruleValues, TITLE_FIELD, titleRule } from "../lib/boardFilters";
import { pendingPeople, personLabel } from "../lib/people";
import { optionColor } from "./TaskStatus";

export type { BoardFilterRule };

/**
 * The board's filter menu.
 *
 * The title search is the one always-visible box, because free text is how
 * most filtering starts. Every column is reachable from "Add filter": options
 * and people are checklists, text is a contains box, numbers and dates take a
 * comparison. A rule is applied the moment it is chosen — there is no Apply
 * button — and "Clear all" is the way back.
 */
export function BoardFilter({
  board,
  rules,
  onChange,
  members,
  pending,
}: {
  board: Board;
  rules: BoardFilterRule[];
  onChange: (next: BoardFilterRule[]) => void;
  members: Member[];
  pending: Invite[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const activeCount = rules.filter(
    (rule) => rule.op === "empty" || rule.op === "not_empty" || ruleValues(rule).length > 0,
  ).length;
  const searchRule = titleRule(rules);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editing || adding) {
        setEditing(null);
        setAdding(false);
        return;
      }
      setOpen(false);
      trigger.current?.focus();
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
  }, [open, editing, adding]);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 300;
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    const top = window.innerHeight - rect.bottom < 420 && rect.top > 440
      ? rect.top - 430
      : Math.min(rect.bottom + 8, window.innerHeight - 420);
    setPosition({ top: Math.max(12, top), left });
    setEditing(null);
    setAdding(false);
    setOpen(true);
  };

  const removeRule = (field: string) => {
    onChange(rules.filter((rule) => rule.field !== field));
  };

  const applyRule = (field: string, op: FilterOp, value?: string | string[]) => {
    const existing = rules.find((rule) => rule.field === field);
    if (value !== undefined && (Array.isArray(value) ? value.length === 0 : !value.trim())) {
      if (existing) onChange(rules.filter((rule) => rule.id !== existing.id));
      return;
    }
    // Choosing an operator before choosing a value must not leave an inert
    // rule behind: the editor is open, and the first value creates the rule.
    if (!existing && value === undefined && op !== "empty" && op !== "not_empty") return;
    const next: BoardFilterRule = {
      id: existing?.id ?? newRuleId(),
      field,
      op,
      ...(value !== undefined ? { value } : {}),
    };
    onChange(
      existing
        ? rules.map((rule) => (rule.id === existing.id ? next : rule))
        : [...rules, next],
    );
  };

  const setTitle = (value: string) => {
    const existing = searchRule;
    if (!value.trim()) {
      if (existing) onChange(rules.filter((rule) => rule.id !== existing.id));
      return;
    }
    const next: BoardFilterRule = {
      id: existing?.id ?? newRuleId(),
      field: TITLE_FIELD,
      op: "contains",
      value,
    };
    onChange(
      existing
        ? rules.map((rule) => (rule.id === existing.id ? next : rule))
        : [...rules, next],
    );
  };

  const editingColumn = editing ? board.columns.find((column) => column.id === editing) ?? null : null;
  const filterable = board.columns;

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
      >
        <Filter />
        Filter
        {activeCount > 0 ? <span className="ws-filter-count">{activeCount}</span> : null}
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menu}
              className="ws-filter-menu ws-filter-menu-wide"
              style={{ top: position.top, left: position.left }}
              role="dialog"
              aria-label="Filter tasks"
            >
              {editingColumn ? (
                <ColumnFilterEditor
                  column={editingColumn}
                  rule={rules.find((rule) => rule.field === editingColumn.id)}
                  onBack={() => setEditing(null)}
                  onApply={(op, value) => applyRule(editingColumn.id, op, value)}
                  onClear={() => {
                    removeRule(editingColumn.id);
                    setEditing(null);
                  }}
                  members={members}
                  pending={pending}
                />
              ) : adding ? (
                <>
                  <div className="ws-filter-head">
                    <button type="button" className="ws-filter-back" onClick={() => setAdding(false)} aria-label="Back">
                      <ArrowLeft aria-hidden="true" />
                    </button>
                    <h3>Add filter</h3>
                  </div>
                  {filterable.length === 0 ? (
                    <p className="ws-select-empty">This board has no columns yet.</p>
                  ) : (
                    <div className="ws-filter-columns">
                      {filterable.map((column) => {
                        const active = rules.some((rule) => rule.field === column.id);
                        return (
                          <button
                            key={column.id}
                            type="button"
                            className="ws-filter-column-row"
                            data-active={active}
                            onClick={() => {
                              setEditing(column.id);
                              setAdding(false);
                            }}
                          >
                            <span className="ws-filter-column-name">{column.name}</span>
                            <span className="ws-filter-column-type">{typeLabel(column.type)}</span>
                            {active ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <label className="ws-filter-search">
                    <Search aria-hidden="true" />
                    <input
                      value={searchRule ? String(searchRule.value) : ""}
                      placeholder="Search task titles…"
                      aria-label="Search task titles"
                      maxLength={200}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                    {searchRule ? (
                      <button
                        type="button"
                        aria-label="Clear title search"
                        onClick={() => removeRule(TITLE_FIELD)}
                      >
                        <X aria-hidden="true" />
                      </button>
                    ) : null}
                  </label>

                  {rules.filter((rule) => rule.field !== TITLE_FIELD).length === 0 ? (
                    <p className="ws-filter-empty">No column filters yet. Add one to narrow the board.</p>
                  ) : (
                    <div className="ws-filter-active">
                      {rules
                        .filter((rule) => rule.field !== TITLE_FIELD)
                        .map((rule) => {
                          const column = board.columns.find((candidate) => candidate.id === rule.field);
                          if (!column) return null;
                          const summary = ruleSummary(board, rule, members, pending);
                          return (
                            <div className="ws-filter-active-row" key={rule.id}>
                              <button
                                type="button"
                                className="ws-filter-active-main"
                                onClick={() => setEditing(column.id)}
                              >
                                <span className="ws-filter-active-key">{column.name}</span>
                                <span className="ws-filter-active-value">{summary}</span>
                              </button>
                              <button
                                type="button"
                                className="ws-filter-active-remove"
                                aria-label={`Clear ${column.name} filter`}
                                onClick={() => removeRule(column.id)}
                              >
                                <X aria-hidden="true" />
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  )}

                  <button type="button" className="ws-filter-add" onClick={() => setAdding(true)}>
                    <Plus aria-hidden="true" /> Add filter
                  </button>

                  {activeCount > 0 ? (
                    <div className="ws-filter-foot">
                      <button type="button" onClick={() => onChange([])}>Clear all</button>
                      <span>{activeCount} active</span>
                    </div>
                  ) : null}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** One column's value editor, chosen by the column's type. */
function ColumnFilterEditor({
  column,
  rule,
  onBack,
  onApply,
  onClear,
  members,
  pending,
}: {
  column: Column;
  rule?: BoardFilterRule;
  onBack: () => void;
  onApply: (op: FilterOp, value?: string | string[]) => void;
  onClear: () => void;
  members: Member[];
  pending: Invite[];
}) {
  const values = rule ? ruleValues(rule) : [];
  const op = rule?.op ?? defaultOp(column);
  const invited = pendingPeople(members, pending);
  const people = [
    ...members.map((member) => ({
      value: member.subject,
      label: personLabel(member),
      pending: false,
    })),
    ...invited.map((invite) => ({
      value: invite.email,
      label: invite.email,
      pending: true,
    })),
  ];

  const choosesValues = column.type === "status" || column.type === "select" || column.type === "multiselect";
  const choosesPeople = column.type === "person";
  const isCheckbox = column.type === "checkbox";
  const isNumber = column.type === "number" || column.type === "progress";
  const isDate = column.type === "date" || column.type === "datetime" || column.type === "daterange";
  const isText = !choosesValues && !choosesPeople && !isCheckbox && !isNumber && !isDate;

  const toggle = (value: string) => {
    const current = values.includes(value)
      ? values.filter((entry) => entry !== value)
      : [...values, value];
    if (current.length === 0) {
      onClear();
      return;
    }
    onApply(op === "is_not" ? "is_not" : "is", current);
  };

  return (
    <>
      <div className="ws-filter-head">
        <button type="button" className="ws-filter-back" onClick={onBack} aria-label="Back">
          <ArrowLeft aria-hidden="true" />
        </button>
        <h3>{column.name}</h3>
        {rule ? (
          <button type="button" className="ws-filter-head-clear" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>

      {choosesValues ? (
        <>
          <OpSegment
            value={op === "is_not" ? "is_not" : op === "empty" ? "empty" : "is"}
            options={[
              { id: "is", label: "is" },
              { id: "is_not", label: "is not" },
              { id: "empty", label: "is empty" },
            ]}
            onChange={(next) => onApply(next as FilterOp, next === "empty" ? undefined : values)}
          />
          {op !== "empty" ? (
            <div className="ws-filter-options">
              {(column.options ?? []).map((option) => {
                const active = values.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="ws-filter-option"
                    data-active={active}
                    aria-pressed={active}
                    onClick={() => toggle(option.id)}
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
            </div>
          ) : null}
        </>
      ) : choosesPeople ? (
        <>
          <OpSegment
            value={op === "is_not" ? "is_not" : op === "empty" ? "empty" : "is"}
            options={[
              { id: "is", label: "is" },
              { id: "is_not", label: "is not" },
              { id: "empty", label: "is empty" },
            ]}
            onChange={(next) => onApply(next as FilterOp, next === "empty" ? undefined : values)}
          />
          {op !== "empty" ? (
            <div className="ws-filter-options">
              {people.map((person) => {
                const active = values.includes(person.value);
                return (
                  <button
                    key={person.value}
                    type="button"
                    className="ws-filter-option"
                    data-active={active}
                    aria-pressed={active}
                    onClick={() => toggle(person.value)}
                  >
                    <span className="ws-filter-option-label">
                      {person.label}
                      {person.pending ? <span className="ws-filter-pending">invited</span> : null}
                    </span>
                    <span className="ws-filter-check" aria-hidden="true">
                      {active ? <Check /> : null}
                    </span>
                  </button>
                );
              })}
              {people.length === 0 ? <p className="ws-select-empty">No people in this project yet.</p> : null}
            </div>
          ) : null}
        </>
      ) : isCheckbox ? (
        <div className="ws-filter-options">
          {[
            { id: "true", label: "Checked" },
            { id: "false", label: "Not checked" },
          ].map((option) => {
            const active = values.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                className="ws-filter-option"
                data-active={active}
                aria-pressed={active}
                onClick={() => {
                  if (active) {
                    onClear();
                    return;
                  }
                  onApply("is", option.id);
                }}
              >
                <span className="ws-filter-option-label">{option.label}</span>
                <span className="ws-filter-check" aria-hidden="true">
                  {active ? <Check /> : null}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className="ws-filter-option"
            data-active={op === "empty"}
            aria-pressed={op === "empty"}
            onClick={() => onApply(op === "empty" ? "not_empty" : "empty")}
          >
            <span className="ws-filter-option-label">No value</span>
            <span className="ws-filter-check" aria-hidden="true">
              {op === "empty" || op === "not_empty" ? <Check /> : null}
            </span>
          </button>
        </div>
      ) : isNumber ? (
        <ValueEditor
          rule={rule}
          op={op}
          inputType="text"
          placeholder="A number"
          ops={[
            { id: "is", label: "is" },
            { id: "gt", label: "greater than" },
            { id: "lt", label: "less than" },
            { id: "empty", label: "is empty" },
          ]}
          onApply={onApply}
        />
      ) : isDate ? (
        <ValueEditor
          rule={rule}
          op={op}
          inputType="date"
          placeholder="A date"
          ops={[
            { id: "is", label: "on" },
            { id: "gt", label: "after" },
            { id: "lt", label: "before" },
            { id: "empty", label: "is empty" },
          ]}
          onApply={onApply}
        />
      ) : (
        <ValueEditor
          rule={rule}
          op={op === "not_contains" ? "not_contains" : op === "empty" ? "empty" : op === "not_empty" ? "not_empty" : "contains"}
          inputType="text"
          placeholder={isText ? "Text to find" : "A value"}
          ops={[
            { id: "contains", label: "contains" },
            { id: "not_contains", label: "does not contain" },
            { id: "empty", label: "is empty" },
            { id: "not_empty", label: "has a value" },
          ]}
          onApply={onApply}
        />
      )}
    </>
  );
}

function ValueEditor({
  rule,
  op,
  ops,
  inputType,
  placeholder,
  onApply,
}: {
  rule?: BoardFilterRule;
  op: FilterOp;
  ops: Array<{ id: string; label: string }>;
  inputType: string;
  placeholder: string;
  onApply: (op: FilterOp, value?: string | string[]) => void;
}) {
  const value = rule?.value !== undefined && !Array.isArray(rule.value) ? rule.value : "";
  const needsValue = op !== "empty" && op !== "not_empty";
  return (
    <>
      <OpSegment
        value={op}
        options={ops}
        onChange={(next) =>
          onApply(
            next as FilterOp,
            next === "empty" || next === "not_empty" ? undefined : value || undefined,
          )
        }
      />
      {needsValue ? (
        <input
          className="ws-filter-input"
          type={inputType}
          value={value}
          autoFocus
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={200}
          onChange={(event) => onApply(op, event.target.value)}
        />
      ) : null}
    </>
  );
}

function OpSegment({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="ws-filter-ops" role="group">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-active={value === option.id}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function defaultOp(column: Column): FilterOp {
  if (column.type === "text" || column.type === "longtext" || column.type === "url"
    || column.type === "email" || column.type === "phone") {
    return "contains";
  }
  return "is";
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

/** The words one rule puts in a chip and in the menu's row. */
export function ruleSummary(
  board: Board,
  rule: BoardFilterRule,
  members: Member[],
  pending: Invite[],
): string {
  if (rule.op === "empty") return "is empty";
  if (rule.op === "not_empty") return "has a value";
  const column = board.columns.find((candidate) => candidate.id === rule.field) ?? null;
  const values = ruleValues(rule);
  const isNot = rule.op === "is_not" || rule.op === "not_contains";
  let text = "";
  if (rule.field === TITLE_FIELD) {
    text = values.join(", ");
  } else if (column?.type === "checkbox") {
    text = values.includes("true") ? "Checked" : "Not checked";
  } else if (column?.options?.length) {
    text = values
      .map((value) => column.options?.find((option) => option.id === value)?.label ?? value)
      .join(", ");
  } else if (column?.type === "person") {
    text = values
      .map((value) => {
        const member = members.find((entry) => entry.subject === value);
        if (member) return personLabel(member);
        const invite = pending.find((entry) => entry.email.toLowerCase() === value.toLowerCase());
        return invite ? invite.email : value;
      })
      .join(", ");
  } else {
    text = values.join(", ");
  }
  if (rule.op === "gt") return `after ${text}`;
  if (rule.op === "lt") return `before ${text}`;
  return isNot ? `not ${text}` : text;
}

/** A rule's value labels, for the chips above the board. */
export function ruleChip(
  board: Board,
  rule: BoardFilterRule,
  members: Member[],
  pending: Invite[],
): { key: string; value: string } {
  const column = board.columns.find((candidate) => candidate.id === rule.field) ?? null;
  return {
    key: rule.field === TITLE_FIELD ? "Title" : column?.name ?? "Filter",
    value: rule.field === TITLE_FIELD
      ? `contains “${String(rule.value ?? "")}”`
      : ruleSummary(board, rule, members, pending),
  };
}
