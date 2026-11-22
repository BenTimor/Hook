import type { ChatMessage } from "./types";
import type { ToolStep, WorkStep } from "./WorkSteps";

/** A user message drawn on its own. */
export interface MessageBlock<M extends ChatMessage> {
  type: "message";
  key: string;
  message: M;
}

/** One message the model wrote, in the turn's own order. */
export interface AnswerTextPart<M extends ChatMessage> {
  kind: "text";
  key: string;
  message: M;
  text: string;
}

/** One fold of thinking and tool calls between two messages. */
export interface AnswerWorkPart {
  kind: "work";
  key: string;
  steps: WorkStep[];
  live: boolean;
}

export type AnswerPart<M extends ChatMessage> =
  | AnswerTextPart<M>
  | AnswerWorkPart;

/**
 * One assistant turn. `parts` is what the reader sees, in the order it
 * happened: a message, the work it set off, the next message. `message` is the
 * message the turn's actions belong to.
 */
export interface AnswerBlock<M extends ChatMessage> {
  type: "answer";
  key: string;
  message?: M;
  parts: AnswerPart<M>[];
  live: boolean;
}

export type ThreadBlock<M extends ChatMessage> = MessageBlock<M> | AnswerBlock<M>;

interface BuildOptions {
  /** Advanced mode: hidden tool traffic and intermediate messages are shown. */
  showDetails: boolean;
  /**
   * The simple view draws only the turn's last message. A product turns this
   * off for a conversation whose agent was not told that rule (a direct coding
   * chat), keeping the simple view Hook always had: one bubble per message.
   */
  finalOnly: boolean;
  /** The text of the streaming reply, before the message has been saved. */
  streamText?: string;
  /** The reasoning of the streaming reply, before the message has been saved. */
  streamReasoning?: string;
  /** The chat has a turn running right now. */
  turnRunning: boolean;
}

/**
 * Turn the flat message list into what the thread draws. A turn starts after a
 * user message (or a previous answer) and ends when the assistant replies
 * without calling a tool.
 *
 * Advanced mode keeps the turn in reading order: every message the model
 * wrote, with one fold of thinking and tool calls between the messages.
 *
 * The simple view draws only the turn's last message. The agent is told that
 * this is all the user sees, so the answer has to be complete there; everything
 * before it — earlier messages, thinking, tool calls — belongs to advanced mode.
 */
export function buildBlocks<M extends ChatMessage>(
  messages: M[],
  options: BuildOptions,
): ThreadBlock<M>[] {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      results.set(message.toolCallId, message.content);
    }
  }

  // A direct coding chat is the engine's own conversation: Hook cannot tell it
  // that only the last message is read, so its simple view keeps every message.
  if (!options.showDetails && !options.finalOnly) {
    return messages
      .filter(
        (message) =>
          !message.hidden &&
          message.role !== "system" &&
          message.role !== "tool",
      )
      .map((message): ThreadBlock<M> => {
        if (message.role === "user") {
          return { type: "message", key: message.id, message };
        }
        const text =
          message.status === "streaming" && options.streamText !== undefined
            ? options.streamText
            : message.content;
        return {
          type: "answer",
          key: message.id,
          message,
          parts: [{ kind: "text", key: message.id, message, text }],
          live: message.status === "streaming",
        };
      });
  }

  // The simple view drops hidden traffic before grouping; the advanced one
  // keeps it and never draws a system message or a hidden user message.
  const shown = messages.filter((message) =>
    options.showDetails
      ? message.role !== "system" && (message.role !== "user" || !message.hidden)
      : !message.hidden && message.role !== "system" && message.role !== "tool",
  );

  const blocks: ThreadBlock<M>[] = [];
  let turn: M[] = [];

  const flush = (isLast: boolean) => {
    if (turn.length === 0) return;
    const block = buildTurn(turn, results, options, isLast);
    if (block) blocks.push(block);
    turn = [];
  };

  for (const message of shown) {
    if (message.role === "user") {
      flush(false);
      blocks.push({ type: "message", key: message.id, message });
      continue;
    }

    turn.push(message);
    // A complete reply with no tool calls is the end of its turn. Another
    // assistant message can follow it without a new user message (a wake from
    // a coding agent), and that one belongs to its own, separate block —
    // otherwise folding the later turn would hide the earlier answer.
    if (
      message.role === "assistant" &&
      message.status !== "streaming" &&
      (message.toolCalls?.length ?? 0) === 0
    ) {
      flush(false);
    }
  }
  flush(true);
  return blocks;
}

function buildTurn<M extends ChatMessage>(
  turn: M[],
  results: Map<string, string>,
  options: BuildOptions,
  isLast: boolean,
): AnswerBlock<M> | null {
  const assistants = turn.filter((message) => message.role === "assistant");
  if (assistants.length === 0) return null;

  const last = assistants[assistants.length - 1];
  const streaming = last.status === "streaming";
  const final = (last.toolCalls?.length ?? 0) === 0 ? last : undefined;
  // The last turn is still going while the model narrates (streaming) or has
  // handed over to a tool that has not produced the next model call yet. Older
  // turns are history even when they ended on a tool call (an abandoned run).
  const live =
    streaming || (isLast && options.turnRunning && (last.toolCalls?.length ?? 0) > 0);
  const answerText = (message: M) => {
    const streamText =
      message.id === last.id && streaming ? options.streamText : undefined;
    return streamText !== undefined ? streamText : message.content;
  };

  if (!options.showDetails) {
    // The simple view has no work block to fall back on: draw the turn's last
    // message and nothing before it. A blank message is still drawn while it
    // streams (the thinking dots) or when it carries an error or a stop note;
    // otherwise fall back to the last message that actually said something, so
    // a silent follow-up can never blank out the answer above it.
    const fallback =
      !live &&
      answerText(last).trim() === "" &&
      last.status !== "error" &&
      last.status !== "aborted"
        ? [...assistants]
            .reverse()
            .find((message) => answerText(message).trim() !== "")
        : undefined;
    const shown = fallback ?? last;
    const text = answerText(shown);
    const keep =
      text.trim() !== "" ||
      (shown === last && streaming) ||
      shown.status === "error" ||
      shown.status === "aborted";
    return {
      type: "answer",
      key: shown.id,
      message: shown,
      parts: keep
        ? [{ kind: "text", key: shown.id, message: shown, text }]
        : [],
      live,
    };
  }

  const parts: AnswerPart<M>[] = [];
  const pushWork = (key: string, steps: WorkStep[]) => {
    if (steps.length === 0) return;
    const previous = parts[parts.length - 1];
    // Consecutive tool rounds with nothing said between them are one fold.
    if (previous?.kind === "work") {
      previous.steps.push(...steps);
      return;
    }
    parts.push({ kind: "work", key, steps, live: false });
  };

  for (const message of assistants) {
    if (message.role !== "assistant") continue;
    const streamReasoning =
      message.id === last.id && streaming ? options.streamReasoning : undefined;
    const reasoning =
      (streamReasoning !== undefined
        ? streamReasoning
        : message.reasoning
      )?.trim() ?? "";
    const text = answerText(message).trim();
    const calls = message.toolCalls ?? [];
    const steps: WorkStep[] = [];

    if (reasoning) {
      steps.push({
        kind: "reasoning",
        id: `${message.id}-reasoning`,
        text: reasoning,
        streaming: streaming && message.id === last.id,
      });
    }
    for (const call of calls) {
      const hasResult = results.has(call.id);
      steps.push({
        kind: "tool",
        id: call.id,
        name: call.name,
        args: parseArguments(call.arguments),
        output: hasResult ? results.get(call.id) : undefined,
        running: !hasResult && isLast && options.turnRunning,
      });
    }

    if (text && calls.length > 0) {
      // The message was written before the calls it made, so it comes first;
      // the fold sits between it and whatever the model says next.
      parts.push({ kind: "text", key: message.id, message, text });
      pushWork(`${message.id}-work`, steps);
    } else if (text) {
      // Thinking that produced a final answer belongs above that answer.
      pushWork(`${message.id}-work`, steps);
      parts.push({ kind: "text", key: message.id, message, text });
    } else {
      pushWork(`${message.id}-work`, steps);
    }
  }

  // Only the newest fold stays open while the turn runs; the earlier ones have
  // already handed over to a message and fold like history.
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.kind === "work") {
      part.live = live;
      break;
    }
  }

  const textParts = parts.filter(
    (part): part is AnswerTextPart<M> => part.kind === "text",
  );
  const message = textParts[textParts.length - 1]?.message ?? final;

  return {
    type: "answer",
    key: final?.id ?? last.id,
    message,
    parts,
    live,
  };
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Exported for the agent inspector, which builds the same tool steps. */
export function toolStepFromTranscript(item: {
  id: string;
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  status?: string;
}): ToolStep {
  return {
    kind: "tool",
    id: item.id,
    name: item.name || "tool",
    args: item.args,
    output: item.output,
    isError: item.isError,
    running: item.status === "running",
  };
}
