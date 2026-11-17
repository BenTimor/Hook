/** The parts of a chat message the surface needs. Both apps have richer ones. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status?: string;
  error?: string | null;
  hidden?: boolean;
}

/** A picture staged in the composer, already downscaled. */
export interface DraftImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}
