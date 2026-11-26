import { isMetaLine } from "./meta.ts";
import { ruleFor } from "./rules.ts";

/**
 * What Copy puts on the clipboard for a reply.
 *
 * A direction marker is structure, not text, and it is never drawn: `:::rtl` and
 * its closing `:::` flip what they hold, and the `::meta{direction=…}` line on
 * the top says how the whole thing reads. Copying them gives the reader fences
 * that only Hook understands, so a copy keeps the message and drops its markers.
 *
 * Nothing else is touched: the body between the fences is exactly what was
 * written, and a line inside a fenced code block is text like any other — a
 * `:::` in it is never a marker. Only the top line can be metadata; a `::meta`
 * further down is drawn as the words it is, so it is copied as the words it is.
 */
export function copyableMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  /** The block fences still open, each with whether it only sets a direction. */
  const open: boolean[] = [];
  let code: { char: string; size: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (code) {
      if (codeClose(line, code)) code = null;
      kept.push(line);
      continue;
    }

    const fence = codeOpen(line);
    if (fence) {
      code = fence;
      kept.push(line);
      continue;
    }

    if (index === 0 && isMetaLine(line)) continue;

    const block = blockFence(line);
    if (block?.name) {
      const direction = Boolean(ruleFor(block.name, "block")?.dir);
      open.push(direction);
      if (!direction) kept.push(line);
      continue;
    }
    if (block) {
      // A closing fence belongs to the last one opened, however long either is.
      // The stack is per message, so an unbalanced fence is copied as typed.
      if (open.pop() !== true) kept.push(line);
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

/**
 * `:::note[Title]` or a bare `:::`, on a line of its own. A labelled opening is
 * a fence too: it has to be counted, or the closing fence after it would be
 * taken for a direction wrapper's own.
 */
const FENCE = /^ {0,3}:{3,}([A-Za-z][\w-]*)?(?:\[[^\]\n]*\])?[ \t]*$/;

/** Three or more backticks or tildes, then an info string: a code block opens. */
const CODE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function blockFence(line: string): { name: string | null } | null {
  const fence = FENCE.exec(line);
  if (!fence) return null;
  return { name: fence[1] ?? null };
}

function codeOpen(line: string): { char: string; size: number } | null {
  // A backtick fence may not carry a backtick in its info string, or `a ``` b`
  // would swallow the rest of the message.
  const fence = CODE_OPEN.exec(line);
  if (!fence) return null;
  if (fence[1][0] === "`" && fence[2].includes("`")) return null;
  return { char: fence[1][0], size: fence[1].length };
}

function codeClose(line: string, code: { char: string; size: number }): boolean {
  const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(fence && fence[1][0] === code.char && fence[1].length >= code.size);
}
