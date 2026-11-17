import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { highlight } from "./highlight";
import { copyText } from "./clipboard";

interface Props {
  code: string;
  lang: string;
  streaming: boolean;
}

export function CodeBlock({ code, lang, streaming }: Props) {
  const [html, setHtml] = useState("");
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (streaming) {
      setHtml("");
      return;
    }
    let alive = true;
    void highlight(code, lang).then((result) => {
      if (alive) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        <button className="copy-btn" onClick={() => void copy()}>
          {copied ? <Check strokeWidth={2.2} /> : <Copy strokeWidth={1.9} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
