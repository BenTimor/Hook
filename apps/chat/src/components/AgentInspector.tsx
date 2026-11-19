import { useEffect, useRef, useState } from "react";
import { Activity, X } from "lucide-react";

import { api } from "../lib/bridge";
import type { AgentTranscript } from "../lib/types";
import {
  Markdown,
  ReasoningStepView,
  ToolStepView,
  toolStepFromTranscript,
} from "@hook/chat";
import { useChatStore } from "../store/useChatStore";

function stateLabel(state: string): string {
  switch (state) {
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
      return state;
  }
}

/** States in which the transcript can still grow. */
function isGrowing(state: string): boolean {
  return state === "starting" || state === "running" || state === "needs_input";
}

function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Could not read this run.";
}

/**
 * One coding agent's transcript, opened from the sidebar tree. It is the same
 * renderer as the conversation's work block — thinking, narration, tool calls
 * and results — laid out in order and read-only on purpose. Steering a run is
 * a conversation with the chat agent, never a button here.
 */
export function AgentInspector() {
  const id = useChatStore((s) => s.inspectAgentId);
  const inspectAgent = useChatStore((s) => s.inspectAgent);
  const summary = useChatStore((s) =>
    s.inspectAgentId
      ? s.agents.agents.find((agent) => agent.id === s.inspectAgentId)
      : undefined,
  );

  const [transcript, setTranscript] = useState<AgentTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer = 0;
    let attempts = 0;
    let wasGrowing = false;

    const load = () => {
      void api
        .agentTranscript(id)
        .then((next) => {
          if (!alive) return;
          setTranscript(next);
          setError(null);
          if (isGrowing(next.state)) {
            wasGrowing = true;
            timer = window.setTimeout(load, 1200);
          } else if (wasGrowing) {
            // The run just settled. Give pi's last session write a moment to
            // land, then read once more so the final message is not missed.
            wasGrowing = false;
            timer = window.setTimeout(load, 900);
          }
        })
        .catch((failure) => {
          if (!alive) return;
          setError(textOf(failure));
          // It may simply not be written yet; try a few more times.
          attempts += 1;
          if (attempts < 4) timer = window.setTimeout(load, 2500);
        });
    };

    setTranscript(null);
    setError(null);
    stick.current = true;
    load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        inspectAgent(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, inspectAgent]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  if (!id) return null;

  const state = transcript?.state ?? summary?.state ?? "";
  const title = transcript?.title ?? summary?.title ?? "Coding agent";
  const project = transcript?.project ?? summary?.project ?? "";
  const items = transcript?.items ?? [];

  return (
    <aside className="agent-inspector" aria-label="Coding agent transcript">
      <header className="agent-inspector-head">
        <span
          className="agent-inspector-dot"
          data-state={state}
          aria-hidden="true"
        />
        <div className="agent-inspector-identity">
          <strong>{title}</strong>
          <span>
            {project}
            {state ? ` · ${stateLabel(state)}` : ""}
          </span>
        </div>
        <button
          className="icon-btn"
          title="Close the inspector"
          aria-label="Close the inspector"
          onClick={() => inspectAgent(null)}
        >
          <X strokeWidth={2} />
        </button>
      </header>

      <div
        className="agent-inspector-scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
        }}
      >
        <div className="agent-inspector-body">
          {error && !transcript ? (
            <div className="agent-inspector-empty">{error}</div>
          ) : items.length === 0 ? (
            <div className="agent-inspector-empty">
              <Activity strokeWidth={1.7} />
              {isGrowing(state)
                ? "Nothing written yet. The run has just started."
                : "This run did not leave a transcript."}
            </div>
          ) : (
            <>
              {transcript?.truncated && (
                <div className="agent-inspector-note">
                  Older entries were dropped to keep this view readable.
                </div>
              )}
              {items.map((item) => {
                if (item.kind === "user") {
                  return (
                    <div className="agent-inspector-task" key={item.id}>
                      <span>Task</span>
                      <p>{item.text}</p>
                    </div>
                  );
                }
                if (item.kind === "thinking") {
                  return (
                    <ReasoningStepView
                      key={item.id}
                      step={{ kind: "reasoning", id: item.id, text: item.text ?? "" }}
                    />
                  );
                }
                if (item.kind === "text") {
                  return (
                    <div className="agent-inspector-text" key={item.id}>
                      <Markdown content={item.text ?? ""} />
                    </div>
                  );
                }
                return (
                  <ToolStepView key={item.id} step={toolStepFromTranscript(item)} />
                );
              })}
            </>
          )}
        </div>
      </div>

      <footer className="agent-inspector-foot">
        Read-only. Ask the chat agent to steer, answer or stop this run.
      </footer>
    </aside>
  );
}
