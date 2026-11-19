import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  Bot,
  Brain,
  ChevronDown,
  FilePlus2,
  FileText,
  FolderTree,
  Globe,
  ListChecks,
  MessageSquare,
  PanelRight,
  PencilLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideProps,
} from "lucide-react";

import { Markdown } from "./Markdown";
import "./chat.css";

/** One item inside a turn's work block, shared by the chat and the inspector. */
export interface ReasoningStep {
  kind: "reasoning";
  id: string;
  text: string;
  streaming?: boolean;
}

export interface TextStep {
  kind: "text";
  id: string;
  text: string;
}

export interface ToolStep {
  kind: "tool";
  id: string;
  name: string;
  /** Already parsed when the producer could; a JSON string also works. */
  args?: unknown;
  output?: string;
  isError?: boolean;
  running?: boolean;
}

export type WorkStep = ReasoningStep | TextStep | ToolStep;

/**
 * The thinking and tool calls of one turn, folded into a single line until the
 * answer lands. It opens itself while the turn is running and folds the moment
 * the last reply arrives; a click reopens it for as long as the reader wants.
 */
export function WorkGroup({
  steps,
  live,
  className,
}: {
  steps: WorkStep[];
  live?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(Boolean(live));
  const wasLive = useRef(Boolean(live));
  const tools = steps.filter(
    (step): step is ToolStep => step.kind === "tool",
  ).length;
  const thoughts = steps.some((step) => step.kind === "reasoning");

  useEffect(() => {
    if (live && !wasLive.current) setOpen(true);
    else if (!live && wasLive.current) setOpen(false);
    wasLive.current = Boolean(live);
  }, [live]);

  if (steps.length === 0) return null;

  const parts: string[] = [];
  if (thoughts) parts.push("thinking");
  if (tools) parts.push(`${tools} tool call${tools === 1 ? "" : "s"}`);
  const summary = parts.length ? parts.join(" · ") : `${steps.length} steps`;

  return (
    <section
      className={className ? `work-group ${className}` : "work-group"}
      data-live={live ? "true" : undefined}
    >
      <button
        className="work-group-head"
        aria-expanded={open}
        title={open ? "Hide thinking and tool calls" : "Show thinking and tool calls"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="work-group-icon" aria-hidden="true">
          <Sparkles strokeWidth={1.9} />
        </span>
        <span className="work-group-label">
          {live ? "Working" : capitalise(summary)}
          {live && <span className="work-group-live"> — {summary}</span>}
        </span>
        <ChevronDown className="work-group-chevron" strokeWidth={2} />
      </button>

      {open && (
        <div className="work-group-items">
          {steps.map((step) => {
            if (step.kind === "reasoning") {
              return <ReasoningStepView key={step.id} step={step} />;
            }
            if (step.kind === "text") {
              return (
                <div className="work-text" key={step.id}>
                  <Markdown content={step.text} />
                </div>
              );
            }
            return <ToolStepView key={step.id} step={step} />;
          })}
        </div>
      )}
    </section>
  );
}

/** Thinking, in the provider's own words. Capped so one long chain of thought
 * cannot push the conversation off the screen. */
export function ReasoningStepView({ step }: { step: ReasoningStep }) {
  return (
    <div className="work-thinking" data-streaming={step.streaming ? "true" : undefined}>
      <div className="work-thinking-head">
        <Brain strokeWidth={1.8} />
        <span>Thinking</span>
        {step.streaming && <span className="work-thinking-live">now</span>}
      </div>
      <div className="work-thinking-body">{step.text}</div>
    </div>
  );
}

type ToolMeta = {
  running: string;
  done: string;
  Icon: ComponentType<LucideProps>;
};

const TOOLS: Record<string, ToolMeta> = {
  bash: { running: "Running a command", done: "Ran a command", Icon: Terminal },
  shell: { running: "Running a command", done: "Ran a command", Icon: Terminal },
  read: { running: "Reading a file", done: "Read a file", Icon: FileText },
  write: { running: "Writing a file", done: "Wrote a file", Icon: FilePlus2 },
  edit: { running: "Editing a file", done: "Edited a file", Icon: PencilLine },
  grep: { running: "Searching the code", done: "Searched the code", Icon: Search },
  search: { running: "Searching", done: "Searched", Icon: Search },
  find: { running: "Looking around", done: "Looked around", Icon: FolderTree },
  ls: { running: "Looking around", done: "Looked around", Icon: FolderTree },
  web_search: { running: "Searching the web", done: "Searched the web", Icon: Globe },
  update_plan: { running: "Updating the plan", done: "Updated the plan", Icon: ListChecks },
  report_progress: {
    running: "Sending an update",
    done: "Sent an update",
    Icon: MessageSquare,
  },
  show_preview: {
    running: "Showing a preview",
    done: "Showed a preview",
    Icon: PanelRight,
  },
  start_coding_agent: {
    running: "Starting a coding agent",
    done: "Started a coding agent",
    Icon: Bot,
  },
};

/**
 * One tool call: a readable title, the part of the arguments that identifies
 * the work, and — on demand — the full arguments and result. Raw JSON is never
 * the first thing the reader sees.
 */
export function ToolStepView({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const meta = metaFor(step.name);
  const detail = detailOf(step.name, step.args);
  const args = prettyArgs(step.args);
  const output = prettyOutput(step.output);
  const running = Boolean(step.running);

  return (
    <div
      className="tool-call"
      data-error={step.isError ? "true" : undefined}
      data-running={running ? "true" : undefined}
    >
      <button
        className="tool-call-head"
        aria-expanded={open}
        title={open ? "Hide the details" : "Show arguments and result"}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-call-icon" aria-hidden="true">
          <meta.Icon strokeWidth={1.8} />
        </span>
        <span className="tool-call-heading">
          <span className="tool-call-title">
            {running ? meta.running : step.isError ? `${meta.done} — failed` : meta.done}
          </span>
          {detail && <span className="tool-call-detail">{detail}</span>}
        </span>
        {running ? (
          <span className="tool-call-spin" aria-label="Running" />
        ) : (
          <ChevronDown className="tool-call-chevron" strokeWidth={2} />
        )}
      </button>

      {open && (
        <div className="tool-call-body">
          {args && (
            <div className="tool-section">
              <div className="tool-section-label">Arguments</div>
              <pre className="tool-pre">{args}</pre>
            </div>
          )}
          {output !== undefined ? (
            <div className="tool-section">
              <div className="tool-section-label">
                {step.isError ? "Error" : "Result"}
              </div>
              <pre className="tool-pre">{output || "No output."}</pre>
            </div>
          ) : (
            !running && (
              <div className="tool-section">
                <div className="tool-section-label">Result</div>
                <pre className="tool-pre">{step.isError ? "The tool failed." : "No output."}</pre>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function metaFor(name: string): ToolMeta {
  return (
    TOOLS[name] ?? {
      running: `Running ${humanName(name)}`,
      done: humanName(name),
      Icon: Wrench,
    }
  );
}

function humanName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  if (!words) return "Used a tool";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function argRecord(args: unknown): Record<string, unknown> | null {
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;
}

/** The one line under the title: the command, the path, or the query. */
function detailOf(name: string, args: unknown): string {
  const record = argRecord(args);
  if (!record) return "";

  if (name === "update_plan") {
    const steps = record.steps;
    return Array.isArray(steps) ? `${steps.length} step${steps.length === 1 ? "" : "s"}` : "";
  }
  if (name === "report_progress") {
    return oneLine(stringValue(record.note), 140);
  }

  const keys = [
    "command",
    "file_path",
    "path",
    "file",
    "pattern",
    "query",
    "url",
    "project",
    "name",
    "title",
    "session_id",
    "agent_id",
    "text",
    "task",
  ];
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return oneLine(value, 160);
  }
  return "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function prettyArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed || trimmed === "{}") return "";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  if (typeof args === "object") {
    if (Object.keys(args as Record<string, unknown>).length === 0) return "";
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }
  return String(args);
}

function prettyOutput(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  const trimmed = output.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return output;
    }
  }
  return output;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
