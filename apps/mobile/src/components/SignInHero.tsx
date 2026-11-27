import { Code2, LayoutGrid, MessageSquare } from "lucide-react";
import { HookMark } from "@hook/ui";

/**
 * The sign-in hero: Hook at the centre, with the three surfaces it connects.
 *
 * This is deliberately a 2D composition rather than an illustration: three
 * miniature interfaces, thin wires and a small amount of depth make the point
 * ("different tools, one brain") without adding an asset or a second icon set.
 * The whole thing is decorative; the title and copy below carry the meaning.
 */
export function SignInHero() {
  return (
    <div className="signin-hero" aria-hidden="true">
      <svg
        className="hero-wires"
        viewBox="0 0 400 300"
        preserveAspectRatio="none"
        focusable="false"
      >
        <path className="hero-wire" d="M 200 150 C 174 142 156 112 144 84" />
        <path className="hero-wire" d="M 200 150 C 228 134 256 96 262 70" />
        <path className="hero-wire" d="M 200 150 C 230 170 258 204 274 216" />
        <circle className="hero-wire-node" cx="200" cy="150" r="2.6" />
        <circle className="hero-wire-node" cx="168" cy="134" r="2.1" />
        <circle className="hero-wire-node" cx="232" cy="134" r="2.1" />
        <circle className="hero-wire-node" cx="226" cy="170" r="2.1" />
      </svg>

      <div className="hero-core">
        <span className="hero-halo" />
        <div className="hero-mark">
          <HookMark />
        </div>
      </div>

      <div className="hero-slot hero-slot-chat">
        <div className="hero-card hero-card-chat">
          <div className="hero-card-head">
            <MessageSquare />
            <span>Chat</span>
            <i className="hero-live-dot" />
          </div>
          <div className="hero-chat-line hero-chat-line-user" />
          <div className="hero-chat-line hero-chat-line-ai">
            <span />
            <span />
          </div>
          <div className="hero-chat-line hero-chat-line-short" />
        </div>
      </div>

      <div className="hero-slot hero-slot-workspace">
        <div className="hero-card hero-card-workspace">
          <div className="hero-card-head">
            <LayoutGrid />
            <span>Workspace</span>
          </div>
          <div className="hero-board">
            <span>
              <i />
              <i />
              <i />
            </span>
            <span>
              <i />
              <i />
            </span>
            <span>
              <i />
              <i />
            </span>
          </div>
        </div>
      </div>

      <div className="hero-slot hero-slot-code">
        <div className="hero-card hero-card-code">
          <div className="hero-code-head">
            <i />
            <i />
            <i />
            <span>
              <Code2 />
              code
            </span>
          </div>
          <div className="hero-code-line">
            <b className="code-green" />
            <b className="code-cream" />
            <b className="code-muted" />
          </div>
          <div className="hero-code-line">
            <b className="code-muted" />
            <b className="code-sage" />
          </div>
          <div className="hero-code-line">
            <b className="code-cream code-wide" />
          </div>
        </div>
      </div>
    </div>
  );
}
