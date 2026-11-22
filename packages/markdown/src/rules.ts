/**
 * The document dialect: one registry, two renderers.
 *
 * An inline rule is a word typed between a colon and brackets — `:red[text]` —
 * and a block rule is the same word on a fenced line — `:::note[Title]`.
 * Adding a rule is the whole job: the live editor, the read-only renderer and
 * the toolbar all read this table, so a new parser cannot drift between them.
 *
 * Never map a rule to `style`, to a handler or to raw HTML. The read view draws
 * the element and the class below and nothing else, which is what lets documents
 * be shared without a sanitizer.
 */

export type RuleScope = "inline" | "block";

export interface Rule {
  /** Words that select this rule. The first is canonical: the toolbar writes it. */
  names: readonly string[];
  scope: RuleScope;
  /** The element the read view draws. */
  element: "span" | "mark" | "u" | "kbd" | "b" | "small" | "div";
  /** Class on that element, and on the run in the live editor. */
  className: string;
  /** Rules in one family replace each other (`:red` → `:green`) instead of nesting. */
  family: string;
  /** Heading of a block that carries no label. */
  defaultLabel?: string;
}

const COLORS: Rule[] = ["red", "green", "blue", "purple"].map((name) => ({
  names: [name],
  scope: "inline",
  element: "span",
  className: `hook-color-${name}`,
  family: "color",
}));

const CALLOUTS = [
  { name: "note", label: "Note" },
  { name: "tip", label: "Tip" },
  { name: "warning", label: "Warning" },
  { name: "danger", label: "Danger" },
];

export const RULES: readonly Rule[] = [
  ...COLORS,
  { names: ["mark", "highlight"], scope: "inline", element: "mark", className: "hook-mark", family: "mark" },
  { names: ["underline", "u"], scope: "inline", element: "u", className: "hook-underline", family: "underline" },
  { names: ["kbd"], scope: "inline", element: "kbd", className: "hook-kbd", family: "kbd" },
  ...CALLOUTS.map<Rule>(({ name, label }) => ({
    names: [name],
    scope: "block",
    element: "div",
    className: `hook-callout hook-callout-${name}`,
    family: "callout",
    defaultLabel: label,
  })),
];

const BY_NAME = new Map<string, Rule>();
for (const rule of RULES) for (const name of rule.names) BY_NAME.set(name, rule);

/**
 * The rule a word names, if it is registered for that position. A `:note[…]` in
 * a sentence is not a block rule out of place: it stays literal text, and so
 * does `:::red`, because a document must never be reformatted by a typo.
 */
export function ruleFor(name: string | null | undefined, scope: RuleScope): Rule | null {
  if (!name) return null;
  const rule = BY_NAME.get(name);
  return rule && rule.scope === scope ? rule : null;
}

/** The word the toolbar writes and the docs show. */
export function canonical(rule: Rule): string {
  return rule.names[0];
}

/** The rule the toolbar uses for a family, for buttons that apply one thing. */
export function familyRule(family: string): Rule | null {
  return RULES.find((rule) => rule.family === family && rule.scope === "inline") ?? null;
}
