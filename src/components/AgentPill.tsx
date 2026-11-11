import { useChatStore } from "../store/useChatStore";

/**
 * The title-bar pill. The detail lives in the task board above the composer;
 * this only tells the user that something is moving — or blocked — even when
 * they are looking at another chat.
 */
export function AgentPill() {
  const agents = useChatStore((s) => s.agents.agents);
  const working = agents.filter(
    (agent) => agent.state === "starting" || agent.state === "running",
  ).length;
  const waiting = agents.filter((agent) => agent.state === "needs_input").length;
  if (working === 0 && waiting === 0) return null;

  return (
    <div className="agent-pill" role="status" aria-live="polite">
      <span className="agent-dot" data-waiting={waiting > 0 && working === 0} aria-hidden="true" />
      {working > 0
        ? working === 1
          ? "Coding agent working"
          : `${working} coding agents working`
        : "Coding agent waiting for you"}
    </div>
  );
}
