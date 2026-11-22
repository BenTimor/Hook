/**
 * The document dialect replaced inline HTML.
 *
 * Everything the old formatting toolbar wrote — a coloured run, `<mark>`, `<u>` —
 * is rewritten to the directive syntax the editor and every preview now draw:
 * `:red[…]`, `:mark[…]`, `:underline[…]`. Nothing else is touched: a fenced code
 * block or an inline code span keeps its text, so a document *about* HTML keeps
 * its sample intact, and any other HTML is left for the author to see.
 *
 * The rewrite runs on every boot and is idempotent. A row that still matches was
 * written by an older client, which is exactly the case worth repairing.
 */

const COLORS = /<span class="hook-color-(green|blue|red|purple)">([^\n]*?)<\/span>/g;
const MARKS = /<mark>([^\n]*?)<\/mark>/g;
const UNDERLINES = /<u>([^\n]*?)<\/u>/g;

/** Cheap test so a boot does not rewrite documents that have nothing to change. */
export const LEGACY_MARKUP = /<span class="hook-color-(?:green|blue|red|purple)">|<mark>|<u>/;

export function rewriteLegacyMarkup(markdown) {
  if (typeof markdown !== "string" || !LEGACY_MARKUP.test(markdown)) return markdown;

  let fence = 0;
  let fenceChar = "";
  const lines = String(markdown).split("\n");
  const out = lines.map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence > 0) {
      if (marker && marker[1][0] === fenceChar && marker[1].length >= fence) fence = 0;
      return line;
    }
    if (marker) {
      fence = marker[1].length;
      fenceChar = marker[1][0];
      return line;
    }
    // Inline code wins over everything: `split` keeps the spans at odd indexes.
    return line
      .split(/(`+[^`\n]*?`+)/)
      .map((part, index) => (index % 2 === 1 ? part : rewriteSpan(part)))
      .join("");
  });
  return out.join("\n");
}

function rewriteSpan(line) {
  return line
    .replace(COLORS, (_match, color, text) => `:${color}[${label(text)}]`)
    .replace(MARKS, (_match, text) => `:mark[${label(text)}]`)
    .replace(UNDERLINES, (_match, text) => `:underline[${label(text)}]`);
}

/** A label ends at the first `]`, so a bracket inside one is written as an entity. */
function label(text) {
  return text.replace(/]/g, "&#93;");
}
