import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { openExternal } from "./open";
import { CodeBlock } from "./CodeBlock";

interface Props {
  content: string;
  streaming?: boolean;
}

function MarkdownImpl({ content, streaming = false }: Props) {
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
    <div className="md" data-streaming={streaming ? "true" : "false"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
