import { Code2, FileText, Lightbulb, Sparkles } from "lucide-react";

import { greeting } from "../lib/utils";
import { useChatStore } from "../store/useChatStore";
import { Composer } from "./Composer";
import { HookMark } from "./HookMark";

const SUGGESTIONS = [
  { icon: Lightbulb, label: "Explain a tricky concept simply" },
  { icon: Code2, label: "Debug this snippet with me" },
  { icon: FileText, label: "Draft release notes for v2" },
  { icon: Sparkles, label: "Compare two approaches" },
];

export function Hero() {
  const setDraft = useChatStore((s) => s.setDraft);
  const focusComposer = useChatStore((s) => s.focusComposer);

  return (
    <div className="hero">
      <div className="hero-inner">
        <HookMark className="hero-mark" />
        <h1>{greeting()}</h1>
        <p>Ask anything. Every conversation is stored on this machine.</p>
        <Composer />
        <div className="chips">
          {SUGGESTIONS.map(({ icon: Icon, label }) => (
            <button
              key={label}
              className="chip"
              onClick={() => {
                setDraft(label);
                focusComposer();
              }}
            >
              <Icon strokeWidth={1.7} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
