import { memo, useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";

import { documentDirectives } from "./remark.ts";
import { documentImageSource } from "./images.ts";

/**
 * A Hook Workspace document, on any surface.
 *
 * The desktop's editor and its dashboard tile, the chat side panel and the
 * phone's sheet all draw documents through here, so the same Markdown is the
 * same page everywhere. Raw HTML is not parsed at all: the dialect is the only
 * formatting language, and a document can never inject an element.
 */
export interface DocumentMarkdownProps {
  markdown: string;
  /** Where a link should open, when the surface can open one. */
  onOpen?: (url: string) => void;
  className?: string;
}

const remarkPlugins = [remarkGfm, remarkDirective, documentDirectives as never];

export const DocumentMarkdown = memo(function DocumentMarkdown({
  markdown,
  onOpen,
  className = "md",
}: DocumentMarkdownProps) {
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
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
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
