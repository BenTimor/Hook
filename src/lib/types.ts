export type Role = "user" | "assistant" | "system" | "tool";
export type MessageStatus = "complete" | "streaming" | "error" | "aborted";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Attachment {
  id: string;
  file: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** "user" or "screenshot" — purely cosmetic in the UI. */
  kind?: string;
}

/** A picture the user has staged in the composer, before sending. */
export interface DraftImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  reasoning?: string;
  createdAt: number;
  status: MessageStatus;
  error?: string;
  usage?: Usage;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Internal bookkeeping: tool traffic and agent events. Never rendered. */
  hidden?: boolean;
  attachments?: Attachment[];
}

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  pinnedAt?: number;
  messageCount: number;
  preview: string;
}

export interface Chat {
  meta: ChatMeta;
  messages: Message[];
}

export interface SearchHit {
  chat: ChatMeta;
  snippet: string;
}

export interface AppInfo {
  version: string;
}

export interface Project {
  name: string;
  path: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  isGit: boolean;
}

export interface SettingsView {
  projectsDir: string;
  projects: Project[];
}

export interface AgentsOverview {
  working: number;
  live: number;
}

export type StreamEvent =
  | { kind: "started"; messages: Message[]; meta: ChatMeta }
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "done"; messages: Message[]; meta: ChatMeta }
  | { kind: "error"; message: string; messages: Message[]; meta: ChatMeta };

export interface ChatEvent {
  chatId: string;
  event: StreamEvent;
}
