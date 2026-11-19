/** The parts of a chat message the surface needs. Both apps have richer ones. */
export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status?: string;
  error?: string | null;
  hidden?: boolean;
  /** What the model thought before it answered, when the provider sends it. */
  reasoning?: string;
  toolCalls?: ChatToolCall[];
  /** Set on `role: "tool"` results: the call they belong to. */
  toolCallId?: string;
}

/** A picture staged in the composer, already downscaled. */
export interface DraftImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}
