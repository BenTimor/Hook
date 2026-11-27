import test from "node:test";
import assert from "node:assert/strict";

import { latexFractions, normalizeDisplayMath } from "./math.ts";

/**
 * `1/2` is the fraction everybody writes the short way. These cases are the
 * contract: the rewrite happens inside a formula, only where the operands are
 * unambiguous, and never inside text (`\text{km/h}`) or a command argument
 * (`\frac{1}{2}`, `\sqrt{2}`).
 *
 * `String.raw` throughout: a TeX string in this file is the bytes a person
 * typed, not a JavaScript escape.
 */
const cases: [string, string][] = [
  [String.raw`1/2`, String.raw`\frac{1}{2}`],
  [String.raw`a/b`, String.raw`\frac{a}{b}`],
  [String.raw`12/3.5`, String.raw`\frac{12}{3.5}`],
  [String.raw`(a+b)/(c+d)`, String.raw`\frac{a+b}{c+d}`],
  [String.raw`1/(2x)`, String.raw`\frac{1}{2x}`],
  [String.raw`x^2/y`, String.raw`\frac{x^2}{y}`],
  [String.raw`x_{n}/2`, String.raw`\frac{x_{n}}{2}`],
  [String.raw`{a}/{b}`, String.raw`\frac{a}{b}`],
  // Already a fraction, or a command: untouched.
  [String.raw`\frac{1}{2}`, String.raw`\frac{1}{2}`],
  [String.raw`\frac{1}{2}+3/4`, String.raw`\frac{1}{2}+\frac{3}{4}`],
  // A slash inside a command's argument is not ours.
  [String.raw`\text{km/h}`, String.raw`\text{km/h}`],
  // Both of `\href`'s arguments are text: a URL and its label.
  [String.raw`\href{https://x.dev/a/b}{1/2}`, String.raw`\href{https://x.dev/a/b}{1/2}`],
  // Too ambiguous to rewrite.
  [String.raw`\sqrt{2}/2`, String.raw`\sqrt{2}/2`],
  [String.raw`a/b/c`, String.raw`\frac{a}{b}/c`],
  // Nothing to do.
  ["plain", "plain"],
  [String.raw`a+b`, String.raw`a+b`],
];

for (const [input, expected] of cases) {
  test(`${input} ג†’ ${expected}`, () => {
    assert.equal(latexFractions(input), expected);
  });
}

test("a formula that cannot be read keeps its meaning", () => {
  // Whatever the rule does, a slash it cannot resolve stays a slash.
  assert.equal(latexFractions(String.raw`a//b`), String.raw`a//b`);
  assert.equal(latexFractions(String.raw`/2`), String.raw`/2`);
  assert.equal(latexFractions(String.raw`2/`), String.raw`2/`);
});

test("display math fences move to their own lines", () => {
  assert.equal(
    normalizeDisplayMath(String.raw`before $$\Phi = BA$$ after`),
    ["before ", "", "$$", String.raw`\Phi = BA`, "$$", "", " after"].join("\n"),
  );
  assert.equal(
    normalizeDisplayMath(String.raw`$$\Phi = BA
\qquad\Rightarrow\qquad
U = \frac12$$`),
    ["", "", "$$", String.raw`\Phi = BA`, String.raw`\qquad\Rightarrow\qquad`, String.raw`U = \frac12`, "$$", "", ""].join(
      "\n",
    ),
  );
});

test("an already fenced display formula is left alone", () => {
  const source = "$$\n\\Phi = BA\n$$";
  assert.equal(normalizeDisplayMath(source), source);
});

test("display delimiters inside code are not touched", () => {
  const fence = "```";
  const source = `${fence}\n$$x$$\n${fence}`;
  assert.equal(normalizeDisplayMath(source), source);
  assert.equal(normalizeDisplayMath("a `$$x$$` b"), "a `$$x$$` b");
});

test("an escaped dollar never opens display math", () => {
  assert.equal(normalizeDisplayMath(String.raw`a \$\$x\$\$ b`), String.raw`a \$\$x\$\$ b`);
});
