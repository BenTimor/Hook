import test from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";

import { applyRule, decorationsFor, repairTransaction, settle, settleSelection, wrapCallout } from "./live.ts";
import { ruleFor } from "./rules.ts";

type Range = { from: number; to: number; className?: string };

function marks(state: EditorState): Range[] {
  const { all } = decorationsFor(state, [{ from: 0, to: state.doc.length }]);
  const found: Range[] = [];
  all.between(0, state.doc.length, (from, to, decoration) => {
    const className = typeof decoration.spec.class === "string" ? decoration.spec.class : undefined;
    if (className) found.push({ from, to, className });
  });
  return found;
}

function hidden(state: EditorState): Range[] {
  const set = decorationsFor(state, [{ from: 0, to: state.doc.length }]).hidden;
  const found: Range[] = [];
  set.between(0, state.doc.length, (from, to) => {
    found.push({ from, to });
  });
  return found;
}

function lineClasses(state: EditorState): Map<number, string> {
  const classes = new Map<number, string>();
  const { all } = decorationsFor(state, [{ from: 0, to: state.doc.length }]);
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    let name = "";
    all.between(line.from, line.to || line.from + 1, (from, to, decoration) => {
      if (from === to && from === line.from && typeof decoration.spec.class === "string") {
        name += ` ${decoration.spec.class}`;
      }
    });
    if (name) classes.set(number, name.trim());
  }
  return classes;
}

function stateFor(doc: string, from = 0, to = from): EditorState {
  return EditorState.create({ doc, selection: { anchor: from, head: to } });
}

function remove(
  doc: string,
  from: number,
  to: number,
  userEvent = "delete.backward",
  caret = to,
): string {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [EditorState.transactionFilter.of(repairTransaction), history()],
  });
  return state.update({ changes: { from, to }, userEvent }).state.doc.toString();
}

// ── Decorations ──────────────────────────────────────────────────────────────

test("a rule hides its markup and styles its content", () => {
  const text = "a :red[red here] b";
  const state = stateFor(text);
  const covered = hidden(state).map((range) => text.slice(range.from, range.to));
  assert.deepEqual(covered, [":red[", "]"]);
  assert.deepEqual(
    marks(state).filter((range) => range.className === "hook-color-red"),
    [{ from: 7, to: 15, className: "hook-color-red" }],
  );
});

test("markdown's own markup is hidden the same way", () => {
  const text = "**bold** and `code`";
  const covered = hidden(stateFor(text)).map((range) => text.slice(range.from, range.to));
  assert.deepEqual(covered, ["**", "**", "`", "`"]);
});

test("a link keeps its label and carries its address", () => {
  const text = "[label](https://x.dev)";
  const state = stateFor(text);
  assert.deepEqual(
    marks(state).map(({ from, to, className }) => [text.slice(from, to), className]),
    [["label", "cm-link"]],
  );
  const { all } = decorationsFor(state, [{ from: 0, to: text.length }]);
  let attributes: Record<string, string> | undefined;
  all.between(0, text.length, (_from, _to, decoration) => {
    if (decoration.spec.class === "cm-link") {
      attributes = decoration.spec.attributes as Record<string, string> | undefined;
    }
  });
  assert.equal(attributes?.["data-link-url"], "https://x.dev/");
});

test("an unknown word keeps every character on screen", () => {
  const text = ":reed[typo] and :note[1]";
  assert.deepEqual(hidden(stateFor(text)), []);
});

test("a callout draws a heading, a body and a quiet fence", () => {
  const text = "before\n:::note[Heads up]\nbody\n:::";
  const state = stateFor(text);
  const classes = lineClasses(state);
  assert.match(classes.get(2) ?? "", /cm-callout-head/);
  assert.match(classes.get(3) ?? "", /cm-callout-body/);
  assert.match(classes.get(3) ?? "", /cm-callout-body-first/);
  assert.match(classes.get(3) ?? "", /cm-callout-body-last/);
  assert.match(classes.get(4) ?? "", /cm-callout-close/);
  const covered = hidden(state).map((range) => text.slice(range.from, range.to));
  assert.ok(covered.includes(":::note["));
  assert.ok(covered.includes(":::"));
});

test("a nested callout inside a callout is drawn", () => {
  const text = "::::note[Outer]\n:::tip[Inner]\ninner body\n:::\n::::";
  const classes = lineClasses(stateFor(text));
  assert.match(classes.get(1) ?? "", /cm-callout-head/);
  assert.match(classes.get(2) ?? "", /cm-callout-head/);
  for (const line of [1, 2, 3, 4, 5]) assert.ok(classes.get(line), `line ${line}`);
});

// ── Deletion ─────────────────────────────────────────────────────────────────

const RUN = "a :red[red here] b";
const OPEN = RUN.indexOf(":red[");
const CONTENT = OPEN + ":red[".length;
const CLOSE = RUN.indexOf("]", CONTENT);

test("deleting the whole content deletes the whole run", () => {
  assert.equal(remove(RUN, CONTENT, CLOSE), "a  b");
});

test("deleting inside the content deletes one character", () => {
  assert.equal(remove(RUN, CONTENT + 1, CONTENT + 3), "a :red[r here] b");
});

test("deleting only the invisible markup changes nothing visible", () => {
  assert.equal(remove(RUN, OPEN, CONTENT), RUN);
});

test("a backspace that lands on the opening marker deletes the word before it", () => {
  assert.equal(remove(RUN, CONTENT - 1, CONTENT, "delete.backward"), "a:red[red here] b");
});

test("a backspace that lands on the closing marker deletes a character, not the run", () => {
  assert.equal(remove(RUN, CLOSE, CLOSE + 1, "delete.backward"), "a :red[red her] b");
});

test("a forward delete that lands on the closing marker deletes the next character", () => {
  assert.equal(remove(RUN, CLOSE, CLOSE + 1, "delete.forward", CLOSE), "a :red[red here]b");
  const wide = "a :red[red] bc";
  const at = wide.indexOf("]");
  assert.equal(remove(wide, at, at + 1, "delete.forward", at), "a :red[red]bc");
});

test("a selection across the end of a run keeps what it did not delete", () => {
  assert.equal(remove(":blue[hello] world", 9, 17), ":blue[hel]d");
});

test("the reported case: a trailing space inside a run", () => {
  const text = "a :blue[hello what's ]up?";
  const close = text.indexOf("]");
  // Backspace with the caret just past the marker removes the space inside the
  // run, exactly as if the marker were not there.
  assert.equal(remove(text, close, close + 1, "delete.backward"), "a :blue[hello what's]up?");
  // Delete with the caret just before the marker removes the next character.
  assert.equal(remove(text, close, close + 1, "delete.forward", close), "a :blue[hello what's ]p?");
});

test("deleting content plus the following word removes everything", () => {
  assert.equal(remove(RUN, CONTENT, RUN.length), "a ");
});

test("a backspace at the end of the content keeps the run", () => {
  assert.equal(remove(RUN, CLOSE - 1, CLOSE), "a :red[red her] b");
});

test("leaving a run crosses one visible character, not the marker", () => {
  const text = ":green[hello] world";
  const stop = text.indexOf("]");      // the content edge, where the caret rests
  const ghost = stop + 1;              // after the hidden `]`, same place on screen
  const state = stateFor(text, stop);
  // Right: the space after the run is crossed in the same press.
  assert.equal(settle(state, stop, ghost), ghost + 1);
  // Back again: the caret comes back to the same stop, one press.
  assert.equal(settle(state, ghost + 1, ghost), stop);
});

test("leaving a run to the left happens before it", () => {
  const text = "a :green[hello]";
  const state = stateFor(text, 0);
  const from = text.indexOf(":");         // the hidden `:green[`
  const openTo = text.indexOf("[") + 1;   // the content edge, where the caret rests
  assert.equal(settle(state, openTo, from), from - 1);
});

test("a jump onto a marker settles on the content edge", () => {
  const text = ":green[hello] world";
  const stop = text.indexOf("]");
  const state = stateFor(text, stop);
  assert.equal(settle(state, 0, stop + 1), stop);
  assert.equal(settle(state, stop, stop), stop);
});

test("the editor applies the settle rule to a selection change", () => {
  const text = ":green[hello] world";
  const stop = text.indexOf("]");
  const ghost = stop + 1;
  const filter = [EditorState.transactionFilter.of(settleSelection)];
  const resting = EditorState.create({ doc: text, selection: { anchor: stop }, extensions: filter });
  // A press right that would cross only the marker crosses the next character.
  assert.equal(resting.update({ selection: { anchor: ghost } }).state.selection.main.head, ghost + 1);
  // A click that lands on the marker settles on the content edge.
  const elsewhere = EditorState.create({ doc: text, selection: { anchor: 0 }, extensions: filter });
  assert.equal(elsewhere.update({ selection: { anchor: ghost } }).state.selection.main.head, stop);
  assert.equal(elsewhere.update({ selection: { anchor: stop } }).state.selection.main.head, stop);
});

test("bold text is repaired the same way", () => {
  const text = "a **bold** b";
  const open = text.indexOf("**");
  assert.equal(remove(text, open + 2, open + 6), "a  b");
  // A selection of only the invisible markers changes nothing visible.
  assert.equal(remove(text, open, open + 2), text);
  // A backspace that lands on one removes a character instead.
  assert.equal(remove(text, open + 1, open + 2), "a**bold** b");
});

test("a backspace beside an image line removes the image", () => {
  const text = "![alt](https://x.dev/a.png)\ntext";
  const breakAt = text.indexOf("\n");
  assert.equal(remove(text, breakAt, breakAt + 1), "text");
  assert.equal(remove(text, breakAt - 1, breakAt), "text");
});

test("emptying a callout removes the block", () => {
  const text = "before\n:::note[Title]\nbody\n:::\nafter";
  const body = text.indexOf("body");
  assert.equal(remove(text, body, body + 4), "before\nafter");
});

test("joining the body to the heading unwraps the callout", () => {
  const text = ":::note[Title]\nbody\n:::";
  const breakAt = text.indexOf("\n");
  assert.equal(remove(text, breakAt, breakAt + 1), "Titlebody");
});

test("deleting across a run and its neighbours never leaves markup", () => {
  const text = "x :mark[one two] y";
  for (let from = 0; from <= text.length; from += 1) {
    for (let to = from; to <= text.length; to += 1) {
      const result = remove(text, from, to, "delete");
      assert.ok(!/:(mark|red|green|blue|purple)\[/.test(result) || /:mark\[[^\]]*\]/.test(result),
        `[${from},${to}) left ${JSON.stringify(result)}`);
    }
  }
});

test("one undo puts the document back", () => {
  const state = EditorState.create({
    doc: RUN,
    extensions: [EditorState.transactionFilter.of(repairTransaction), history()],
  });
  const after = state.update({ changes: { from: CONTENT, to: CLOSE }, userEvent: "delete.backward" }).state;
  assert.equal(after.doc.toString(), "a  b");
  let undone = after;
  const done = undo({ state: after, dispatch: (transaction) => { undone = transaction.state; } });
  assert.equal(done, true);
  assert.equal(undone.doc.toString(), RUN);
});

// ── Toolbar ──────────────────────────────────────────────────────────────────

test("a colour replaces a colour instead of nesting", () => {
  const text = ":red[hello]";
  const state = stateFor(text, 5, 10);
  const spec = applyRule(state, ruleFor("green", "inline"), "color");
  assert.ok(spec);
  assert.equal(state.update(spec).state.doc.toString(), ":green[hello]");
});

test("default removes the run under the cursor", () => {
  const text = "a :red[hello] b";
  const state = stateFor(text, 9);
  const spec = applyRule(state, null, "color");
  assert.ok(spec);
  assert.equal(state.update(spec).state.doc.toString(), "a hello b");
});

test("a rule wraps a plain selection and keeps it selected", () => {
  const text = "hello there";
  const state = stateFor(text, 6, 11);
  const spec = applyRule(state, ruleFor("mark", "inline"), "mark");
  assert.ok(spec);
  const next = state.update(spec).state;
  assert.equal(next.doc.toString(), "hello :mark[there]");
  assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), "there");
});

test("a rule applies to a bare cursor", () => {
  const state = stateFor("hello", 5);
  const spec = applyRule(state, ruleFor("kbd", "inline"), "kbd");
  assert.ok(spec);
  const next = state.update(spec).state;
  assert.equal(next.doc.toString(), "hello:kbd[]");
  assert.equal(next.selection.main.from, 10);
});

test("the callout button fences the selection as the body", () => {
  const text = "one\ntwo";
  const state = stateFor(text, 0, text.length);
  const next = state.update(wrapCallout(state, ruleFor("tip", "block")!)).state;
  assert.equal(next.doc.toString(), ":::tip[Tip]\none\ntwo\n:::");
  assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), "Tip");
});
