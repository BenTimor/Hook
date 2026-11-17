import { useChatStore } from "../store/useChatStore";
import type { AgentSummary } from "./types";

/** States in which the run still owns work that can be steered or stopped. */
export const LIVE_AGENT_STATES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "needs_input",
]);

export function isLiveAgent(agent: AgentSummary): boolean {
  return LIVE_AGENT_STATES.has(agent.state);
}

/** True when the active chat has a coding agent the user can steer right now. */
export function useSteering(): boolean {
  return useChatStore((s) =>
    s.activeId
      ? s.agents.agents.some(
          (agent) => agent.chatId === s.activeId && isLiveAgent(agent),
        )
      : false,
  );
}
