import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  declaredDirection,
  documentBreaks,
  documentDirectives,
  MATH_REHYPE,
  mathFractions,
  mathProse,
  remarkDirective,
  remarkMath,
} from "@hook/markdown";

import { openExternal } from "./open";
import { CodeBlock } from "./CodeBlock";

/**
 * What Hook said, drawn in the document dialect.
 *
 * A reply is the same Markdown a Hook Workspace document is, so it goes
 * through the same three plugins: `:red[…]`, `:mark[…]`, `:kbd[…]` and a
 * `:::warning[…]` callout draw exactly as they do on a page, and a single
 * newline is a line break rather than the space CommonMark prints (the dialect
 * `docs/document-markdown.md` gives the model), and `$x^2$` is LaTeX. Only a
 * reply goes through here:
 * what the user typed is drawn as the text it is.
 *
 * Its direction is the reply's own, the way a user's message is: `dir="auto"`
 * lays it out from its first strong character, so a reply written in Hebrew or
 * Arabic reads right to left and one that opens in English does not. A reply
 * that says otherwise wins — `:::rtl`/`:::ltr` around a passage, and a
 * `::meta{direction=…}` line on top for the whole message.
 */
interface Props {
  content: string;
  streaming?: boolean;
}

/** The dialect's own plugins, in the order the read view uses them. */
const remarkPlugins = [
  remarkGfm,
  remarkDirective,
  remarkMath,
  mathProse as never,
  mathFractions as never,
  documentDirectives as never,
  documentBreaks as never,
];

/** MathML, so a formula needs no stylesheet and no fonts in a bubble either. */
const rehypePlugins = MATH_REHYPE as never;

function MarkdownImpl({ content, streaming = false }: Props) {
  const direction = useMemo(() => declaredDirection(content), [content]);

  const components = useMemo<Components>(() => {
    return {
      pre({ children }) {
        const child = Array.isArray(children) ? children[0] : children;
        const props = (child as { props?: Record<string, unknown> } | undefined)?.props;
        if (!props) return <pre>{children}</pre>;
        const className = typeof props.className === "string" ? props.className : "";
        const match = /language-([\w+#-]+)/.exec(className);
        const raw = props.children;
        const code = Array.isArray(raw)
          ? raw.join("")
          : typeof raw === "string"
            ? raw
            : String(raw ?? "");
        return (
          <CodeBlock
            code={code.replace(/\n$/, "")}
            lang={match?.[1] ?? ""}
            streaming={streaming}
          />
        );
      },
      a({ href, children }: ComponentPropsWithoutRef<"a">) {
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) void openExternal(href);
            }}
          >
            {children}
          </a>
        );
      },
    };
  }, [streaming]);

  return (
    <div
      className="md"
      dir={direction ?? "auto"}
      data-streaming={streaming ? "true" : "false"}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins as never}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
