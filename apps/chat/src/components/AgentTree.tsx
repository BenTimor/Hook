import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Folder, FolderOpen } from "lucide-react";

import type { AgentSummary } from "../lib/types";
import { isLiveAgent } from "../lib/agents";
import { useChatStore } from "../store/useChatStore";

/** A short word for the tree; the inspector spells the state out. */
function stateWord(state: string): string {
  switch (state) {
    case "starting":
    case "running":
      return "working";
    case "needs_input":
      return "waiting";
    case "idle":
    case "done":
      return "done";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return state;
  }
}

/** Runs with work still to do: the only ones that always earn a row. */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "needs_input",
]);

/** Runs that ended before finishing. They stay in the tree for a few minutes,
 * and only in the chat the user is looking at. */
const ENDED_EARLY_STATES: ReadonlySet<string> = new Set([
  "stopped",
  "failed",
  "interrupted",
]);
const RECENT_MS = 5 * 60_000;

/**
 * The coding agents, in the sidebar's advanced mode: one folder per project,
 * each relevant run underneath it. It is a tree to watch, not to steer —
 * clicking a row opens the read-only inspector. Steering stays a conversation
 * with the chat agent, which is the whole point of Hook.
 *
 * This is not a history list. Only runs that still have work appear, plus a run
 * that stopped in the open chat within the last few minutes (so a failure is
 * visible without opening a transcript first). Runs that finished
 * successfully never appear. Whatever is being inspected stays until the user
 * moves to another chat, so a run that finishes under the pointer does not
 * vanish from the tree.
 */
export function AgentTree() {
  const agents = useChatStore((s) => s.agents.agents);
  const activeChatId = useChatStore((s) => s.activeId);
  const selected = useChatStore((s) => s.inspectAgentId);
  const inspectAgent = useChatStore((s) => s.inspectAgent);
  const [open, setOpen] = useState(true);
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Let a recently stopped run expire without waiting for another agent event.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const folders = useMemo(() => {
    const byProject = new Map<string, AgentSummary[]>();
    for (const agent of agents) {
      // A directly-driven agent is already a chat in the list: listing it here
      // as well would show the same conversation twice, and this tree is for
      // the runs the chat agent started.
      if (agent.direct) continue;
      const listed =
        agent.id === selected ||
        ACTIVE_STATES.has(agent.state) ||
        (ENDED_EARLY_STATES.has(agent.state) &&
          agent.chatId === activeChatId &&
          now - (agent.finishedAt ?? agent.updatedAt) < RECENT_MS);
      if (!listed) continue;
      const name = agent.project || "Project";
      const list = byProject.get(name);
      if (list) list.push(agent);
      else byProject.set(name, [agent]);
    }
    return [...byProject.entries()]
      .map(([project, list]) => ({
        project,
        agents: [...list].sort((a, b) => {
          if (a.id === selected) return -1;
          if (b.id === selected) return 1;
          const live = Number(isLiveAgent(b)) - Number(isLiveAgent(a));
          return live || b.createdAt - a.createdAt;
        }),
      }))
      .sort((a, b) => a.project.localeCompare(b.project));
  }, [agents, activeChatId, selected, now]);

  const listed = folders.reduce((count, folder) => count + folder.agents.length, 0);
  if (listed === 0) return null;

  const toggleFolder = (project: string) =>
    setClosedFolders((current) => {
      const next = new Set(current);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });

  return (
    <div className="agent-tree">
      <button
        className="agent-tree-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown className="agent-tree-chevron" strokeWidth={2} />
        <span>Coding agents</span>
        <span className="agent-tree-count">{listed}</span>
      </button>

      {open &&
        folders.map((folder) => {
          const closed = closedFolders.has(folder.project);
          return (
            <div className="agent-tree-folder-block" key={folder.project}>
              <button
                className="agent-tree-folder"
                aria-expanded={!closed}
                title={closed ? "Show these runs" : "Hide these runs"}
                onClick={() => toggleFolder(folder.project)}
              >
                <ChevronDown className="agent-tree-chevron" strokeWidth={2} />
                {closed ? (
                  <Folder strokeWidth={1.8} />
                ) : (
                  <FolderOpen strokeWidth={1.8} />
                )}
                <span className="agent-tree-project">{folder.project}</span>
                <span className="agent-tree-count">{folder.agents.length}</span>
              </button>

              {!closed &&
                folder.agents.map((agent) => (
                  <button
                    key={agent.id}
                    className="agent-tree-row"
                    data-state={agent.state}
                    data-active={agent.id === selected}
                    title={`${agent.title || agent.project} — ${stateWord(agent.state)}`}
                    onClick={() => inspectAgent(agent.id)}
                  >
                    <span className="agent-tree-dot" aria-hidden="true" />
                    <span className="agent-tree-title">
                      {agent.title || agent.project}
                    </span>
                    <span className="agent-tree-state">{stateWord(agent.state)}</span>
                  </button>
                ))}
            </div>
          );
        })}
    </div>
  );
}
