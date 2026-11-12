import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Circle, Square } from "lucide-react";

import type { AgentSummary, PlanStep } from "../lib/types";
import { isLiveAgent } from "../lib/agents";
import { useChatStore } from "../store/useChatStore";

/** How long a finished checklist stays under the chat after the run ends. */
const RECENT_MS = 5 * 60_000;

function compactDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stateLabel(agent: AgentSummary): string {
  switch (agent.state) {
    case "starting":
      return "Starting up";
    case "running":
      return "Working";
    case "needs_input":
      return "Waiting for an answer";
    case "idle":
    case "done":
      return "Finished";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Couldn't finish";
    case "interrupted":
      return "Interrupted";
    default:
      return agent.state;
  }
}

/** A visible clock only while something is moving; idle boards cost nothing. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

function StepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "done") return <Check strokeWidth={2.8} />;
  if (status === "active") return <span className="agent-step-spin" aria-hidden="true" />;
  return <Circle strokeWidth={1.7} />;
}

/** How long one step has taken so far, or took in total. Nothing until it starts. */
function stepDuration(step: PlanStep, now: number, live: boolean): string {
  if (step.startedAt === undefined) return "";
  // A live run's current step keeps ticking; a finished run's clocks are frozen.
  const endedAt = step.finishedAt ?? (step.status === "active" && live ? now : undefined);
  if (endedAt === undefined) return "";
  return compactDuration(endedAt - step.startedAt);
}

function AgentTask({
  agent,
  now,
  onStop,
  defaultCollapsed = false,
}: {
  agent: AgentSummary;
  now: number;
  onStop: () => void;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const live = isLiveAgent(agent);
  const total = agent.plan.length;
  const done = agent.plan.filter((step) => step.status === "done").length;
  const meta = total ? `${stateLabel(agent)} · ${done}/${total}` : stateLabel(agent);

  return (
    <section className="agent-card" data-state={agent.state}>
      <header className="agent-card-head">
        <button
          className="agent-card-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? "Show the steps" : "Hide the steps"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span className="agent-card-dot" aria-hidden="true" />
          <span className="agent-card-heading">
            <span className="agent-card-title">{agent.title || agent.project}</span>
            <span className="agent-card-meta">{meta}</span>
          </span>
          {total > 0 && <ChevronDown className="agent-card-chevron" strokeWidth={2} />}
        </button>

        {live && (
          <button
            className="agent-card-stop"
            title="Stop this work completely"
            aria-label="Stop the coding agent"
            onClick={onStop}
          >
            <Square strokeWidth={2.6} fill="currentColor" />
            Stop
          </button>
        )}
      </header>

      {!collapsed &&
        (total > 0 ? (
          <ol className="agent-plan">
            {agent.plan.map((step, index) => {
              const spent = stepDuration(step, now, live);
              return (
                <li className="agent-step" data-status={step.status} key={`${agent.id}-${index}`}>
                  <span className="agent-step-icon" aria-hidden="true">
                    <StepIcon status={step.status} />
                  </span>
                  <span className="agent-step-title">{step.title}</span>
                  {spent && <span className="agent-step-time">{spent}</span>}
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="agent-plan-empty">Getting started…</div>
        ))}
    </section>
  );
}

/**
 * The live task board above the composer. It is the user's window into the
 * coding agent: what it is doing, how far along it is, and the one button that
 * stops it. It is derived entirely from `hook://agents`, so every chat gets it
 * for free and nothing has to be polled.
 */
export function AgentBoard() {
  const activeId = useChatStore((s) => s.activeId);
  const agents = useChatStore((s) => s.agents.agents);
  const stopChatAgents = useChatStore((s) => s.stopChatAgents);

  const mine = useMemo(
    () => (activeId ? agents.filter((agent) => agent.chatId === activeId) : []),
    [agents, activeId],
  );
  const hasLive = mine.some(isLiveAgent);
  const hasRecent = mine.some(
    (agent) =>
      agent.plan.length > 0 &&
      agent.finishedAt !== undefined &&
      Date.now() - agent.finishedAt < RECENT_MS,
  );
  const now = useNow(hasLive || hasRecent);

  const live = mine.filter(isLiveAgent);
  const recent = live.length
    ? []
    : mine
        .filter(
          (agent) =>
            agent.plan.length > 0 &&
            agent.finishedAt !== undefined &&
            now - agent.finishedAt < RECENT_MS,
        )
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .slice(0, 1);

  const shown = live.length ? live : recent;
  if (!activeId || shown.length === 0) return null;

  return (
    <div className="agent-board">
      {shown.map((agent, index) => (
        <AgentTask
          key={agent.id}
          agent={agent}
          now={now}
          // When several runs share a chat, only the first one starts open:
          // three full checklists would eat the conversation.
          defaultCollapsed={shown.length > 1 && index > 0}
          onStop={() => void stopChatAgents()}
        />
      ))}
    </div>
  );
}
