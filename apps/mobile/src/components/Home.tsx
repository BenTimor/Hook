import { Code2, FileText, History, Lightbulb, Settings } from "lucide-react";

import { greeting } from "@hook/chat";
import { HookMark } from "@hook/ui";

import { useMobileChat } from "../store/useMobileChat";
import { ChatComposer } from "./ChatComposer";

const SUGGESTIONS = [
  { icon: Lightbulb, label: "Explain a tricky concept simply" },
  { icon: Code2, label: "Debug this snippet with me" },
  { icon: FileText, label: "Draft release notes for v2" },
];

/**
 * The home screen: a new conversation, not the archive.
 *
 * Like the desktop window, what opens first is the composer with a greeting;
 * the conversations are one tap away behind the history button. Sending here
 * creates the chat, and the same screen becomes its conversation.
 */
export function Home({
  onChats,
  onSettings,
}: {
  onChats: () => void;
  onSettings: () => void;
}) {
  const setDraft = useMobileChat((s) => s.setDraft);

  return (
    <section className="screen home" aria-label="New chat">
      <header className="bar bar-root">
        <div className="bar-brand">
          <HookMark />
          <span>Hook</span>
        </div>
        <div className="bar-actions">
          <button
            className="icon-btn"
            title="Your chats"
            aria-label="Your chats"
            onClick={onChats}
          >
            <History strokeWidth={1.8} />
          </button>
          <button
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={onSettings}
          >
            <Settings strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <div className="hero">
        <div className="hero-inner">
          <h1>{greeting()}</h1>
          <p>Ask anything. Nothing leaves this phone unless your plan syncs it.</p>
          <ChatComposer className="mobile-composer" />
          <div className="chips">
            {SUGGESTIONS.map(({ icon: Icon, label }) => (
              <button
                key={label}
                className="chip"
                onClick={() => setDraft(label)}
              >
                <Icon strokeWidth={1.7} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
