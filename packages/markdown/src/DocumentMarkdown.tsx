import { memo, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";

import { MATH_REHYPE, mathFractions, mathProse, remarkMath } from "./math.ts";
import { documentBreaks, documentDirectives } from "./remark.ts";
import { documentImageSource } from "./images.ts";
import { readDocumentMeta } from "./meta.ts";

/**
 * A Hook Workspace document, on any surface.
 *
 * The desktop's dashboard tile, the chat side panel and the phone's sheet all
 * draw documents through here, so the same Markdown is the same page
 * everywhere. The root carries `hook-doc` (tokens.css), whose numbers are the
 * formatted editor's, so the page a person reads matches the one they wrote —
 * including its line breaks: a single newline is one, as in the editor, never
 * the space CommonMark would put there.
 *
 * Raw HTML is not parsed at all: the dialect is the only formatting language,
 * and a document can never inject an element.
 *
 * The document's direction is its own too: `::meta{direction=rtl}` on the top
 * line flips the page, and the line itself never reaches the output.
 */
export interface DocumentMarkdownProps {
  markdown: string;
  /** Where a link should open, when the surface can open one. */
  onOpen?: (url: string) => void;
  /** Extra class for a surface that sizes the page down, such as a tile. */
  className?: string;
}

const remarkPlugins = [
  remarkGfm,
  remarkDirective,
  remarkMath,
  mathProse as never,
  mathFractions as never,
  documentDirectives as never,
  documentBreaks as never,
];

/** MathML: no stylesheet, no fonts, nothing to inline. */
const rehypePlugins = MATH_REHYPE as never;

export const DocumentMarkdown = memo(function DocumentMarkdown({
  markdown,
  onOpen,
  className,
}: DocumentMarkdownProps) {
  const direction = useMemo(() => readDocumentMeta(markdown).direction, [markdown]);
  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        if (!onOpen) return <span className="hook-doc-link">{children}</span>;
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) onOpen(href);
            }}
          >
            {children}
          </a>
        );
      },
      img({ alt, src }) {
        const source = typeof src === "string" ? documentImageSource(src) : undefined;
        if (!source) return <span>{alt || "Image"}</span>;
        return (
          <img
            className="hook-doc-image"
            src={source}
            alt={alt ?? ""}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        );
      },
      input({ checked }) {
        return <span className="hook-doc-checkbox">{checked ? "☑" : "☐"}</span>;
      },
    }),
    [onOpen],
  );

  return (
    <div
      className={className ? `hook-doc ${className}` : "hook-doc"}
      dir={direction === "rtl" ? "rtl" : undefined}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins as never}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={(url, key, node) =>
          key === "src" && node.tagName === "img"
            ? documentImageSource(url) ?? ""
            : defaultUrlTransform(url)
        }
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
