import { useChatStore } from "../store/useChatStore";

/**
 * Deliberately opaque: the user learns that work is happening, never what it is
 * or which agent. Everything else comes from the chat agent in prose.
 */
export function AgentPill() {
  const working = useChatStore((s) => s.agents.working);
  if (working <= 0) return null;

  return (
    <div className="agent-pill" role="status" aria-live="polite">
      <span className="agent-dot" aria-hidden="true" />
      {working === 1 ? "Coding agent working" : `${working} coding agents working`}
    </div>
  );
}
