/**
 * The document's own metadata: the line at the very top that says what the
 * whole document is, `::meta{direction=rtl}`.
 *
 * It is a leaf directive, so micromark already parses it; this module is the
 * one definition of which line that is, so the read view, the live editor and
 * the tests cannot disagree about what counts as metadata. The line is never
 * drawn: `remark.ts` drops the node and `live.ts` hides it.
 *
 * Direction lives here rather than in a column on the document, so the text is
 * the whole story: copy the Markdown somewhere else and it reads the same way.
 * A document with no line, or with `direction=ltr`, is left to right.
 */

export type TextDirection = "ltr" | "rtl";

export interface DocumentMeta {
  direction: TextDirection;
}

/** The directive word the line uses, so the parser and the editor share it. */
export const META_NAME = "meta";

/** `::meta{...}` as a whole line. Indented up to three spaces, like a block. */
const LINE = /^ {0,3}::meta\{[^}\n]*\}[ \t]*$/;
const DIRECTION = /\bdirection\s*=\s*"?([A-Za-z]+)"?/;

/** Whether a single line is the metadata line. */
export function isMetaLine(text: string): boolean {
  return LINE.test(text);
}

/** The line that sets a direction, for the toolbar to write. */
export function metaLine(direction: TextDirection): string {
  return `::meta{direction=${direction}}`;
}

/** The direction a metadata line names, or null when it names none. */
export function metaDirection(text: string): TextDirection | null {
  if (!isMetaLine(text)) return null;
  const value = DIRECTION.exec(text)?.[1]?.toLowerCase();
  return value === "rtl" ? "rtl" : value === "ltr" ? "ltr" : null;
}

/**
 * What a document says about itself, from its first line only: a metadata line
 * below the top is body text someone wrote, not the document's setting.
 */
export function readDocumentMeta(markdown: string): DocumentMeta {
  const end = markdown.search(/[\r\n]/);
  const first = end === -1 ? markdown : markdown.slice(0, end);
  return { direction: metaDirection(first) ?? "ltr" };
}
