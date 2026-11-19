import type { ChatMessage } from "./types";
import type { ToolStep, WorkStep } from "./WorkSteps";

/** A user message drawn on its own. */
export interface MessageBlock<M extends ChatMessage> {
  type: "message";
  key: string;
  message: M;
}

/**
 * One assistant turn: the work that led to it plus the answer it ended with.
 * `message` is absent while the turn is still working, when everything there is
 * belongs inside the work block.
 */
export interface AnswerBlock<M extends ChatMessage> {
  type: "answer";
  key: string;
  message?: M;
  steps: WorkStep[];
  live: boolean;
}

export type ThreadBlock<M extends ChatMessage> = MessageBlock<M> | AnswerBlock<M>;

interface BuildOptions {
  /** Advanced mode: hidden tool traffic and intermediate messages are shown. */
  showDetails: boolean;
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
 * without calling a tool. Everything before that reply — thinking, narration,
 * tool calls — becomes the work block above it.
 *
 * Without advanced mode hidden messages and tool results are dropped before
 * any of this, which is exactly the conversation the simple view always had.
 */
export function buildBlocks<M extends ChatMessage>(
  messages: M[],
  options: BuildOptions,
): ThreadBlock<M>[] {
  // The simple view is exactly the conversation it always was: one bubble per
  // visible message, no folding. Advanced mode is where turns become groups.
  if (!options.showDetails) {
    return messages
      .filter(
        (message) =>
          !message.hidden && message.role !== "system" && message.role !== "tool",
      )
      .map((message): ThreadBlock<M> =>
        message.role === "user"
          ? { type: "message", key: message.id, message }
          : {
              type: "answer",
              key: message.id,
              message,
              steps: [],
              live: message.status === "streaming",
            },
      );
  }

  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      results.set(message.toolCallId, message.content);
    }
  }

  const shown = messages.filter(
    (message) =>
      message.role !== "system" &&
      (message.role !== "user" || !message.hidden),
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
  const steps: WorkStep[] = [];

  for (const message of assistants) {
    if (message.role !== "assistant") continue;
    const isFinal = final?.id === message.id;
    const streamReasoning =
      message.id === last.id && streaming ? options.streamReasoning : undefined;
    const reasoning =
      streamReasoning !== undefined ? streamReasoning : message.reasoning;
    if (reasoning?.trim()) {
      steps.push({
        kind: "reasoning",
        id: `${message.id}-reasoning`,
        text: reasoning.trim(),
        streaming: streaming && message.id === last.id,
      });
    }

    const streamText =
      message.id === last.id && streaming ? options.streamText : undefined;
    const text = streamText !== undefined ? streamText : message.content;
    if (!isFinal && text.trim()) {
      steps.push({
        kind: "text",
        id: `${message.id}-text`,
        text: text.trim(),
      });
    }

    for (const call of message.toolCalls ?? []) {
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
  }

  // The last turn is still going while the model narrates (streaming) or has
  // handed over to a tool that has not produced the next model call yet. Older
  // turns are history even when they ended on a tool call (an abandoned run).
  const live =
    streaming || (isLast && options.turnRunning && (last.toolCalls?.length ?? 0) > 0);

  // A turn that is only tool traffic has no answer to draw — the work block is
  // the whole thing until the next model call produces a reply.
  return {
    type: "answer",
    key: final?.id ?? last.id,
    message: final,
    steps,
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
