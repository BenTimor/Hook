import { codeToHtml } from "shiki/bundle/web";

const cache = new Map<string, string>();
const MAX = 220;

function escapeHtml(code: string): string {
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  jsx: "jsx",
  tsx: "tsx",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rs: "rust",
  "c++": "cpp",
  cs: "csharp",
  plaintext: "text",
  txt: "text",
};

export async function highlight(code: string, lang: string): Promise<string> {
  const language = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase() ?? "text";
  const key = `${language}\u0000${code}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let html: string;
  try {
    html = await codeToHtml(code, {
      lang: language || "text",
      theme: "github-light",
    });
  } catch {
    try {
      html = await codeToHtml(code, { lang: "text", theme: "github-light" });
    } catch {
      html = `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
  }

  if (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, html);
  return html;
}
