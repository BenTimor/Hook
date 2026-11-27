/** The parts of a chat message the surface needs. Both apps have richer ones. */
export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "compaction" | "picture";
  content: string;
  status?: string;
  error?: string | null;
  hidden?: boolean;
  /** What the model thought before it answered, when the provider sends it. */
  reasoning?: string;
  toolCalls?: ChatToolCall[];
  /** Set on `role: "tool"` results: the call they belong to. */
  toolCallId?: string;
  /** Set on `role: "compaction"`: what the summary folded away. */
  compaction?: ChatCompaction;
  /**
   * Pictures attached to this message. On a `picture` message they are the
   * message; the `content` above is the caption under them.
   */
  attachments?: ChatAttachmentLike[];
}

/** The bits of an attachment this surface reads; a product has the rest. */
export interface ChatAttachmentLike {
  id: string;
  width: number;
  height: number;
  mime: string;
}

/**
 * What one compaction folded. A compaction message is hidden: the simple view
 * never draws it, and advanced mode shows the fold it is.
 */
export interface ChatCompaction {
  /** Messages folded into the summary; `0` when the engine keeps the count. */
  messages: number;
  tokensBefore: number;
  tokensAfter: number;
}

/** One command the composer may offer, as the backend describes it. */
export interface SlashCommand {
  /** Without the slash: `compact`. */
  name: string;
  summary: string;
  /** How it is typed, argument hint included: `/compact [what to keep]`. */
  usage: string;
  /** `"any"` or `"coding"`. */
  scope?: string;
}

/** A picture staged in the composer, already downscaled. */
export interface DraftImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}
