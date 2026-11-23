/**
 * Shiki, replaced by its own fallback in the browser build.
 *
 * `packages/chat/src/highlight.ts` asks Shiki to colour a code block and falls
 * back to `<pre><code>` when it cannot. In a Chromium WebUI that fallback is the
 * right answer: Shiki's web bundle pulls in every grammar and theme as a
 * separate chunk (hundreds of files in our pak) and needs `wasm-unsafe-eval` for
 * its oniguruma engine — a CSP hole and tens of megabytes for colour in a dev
 * build. This module answers with the same markup Shiki's own catch branch
 * produces, so `CodeBlock` is unchanged and nothing else notices.
 *
 * When the browser grows a real code view, this file is the seam: bundle the two
 * or three grammars the product actually uses and drop the alias.
 */

function escapeHtml(code: string): string {
  return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function codeToHtml(code: string): Promise<string> {
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}
