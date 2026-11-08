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
  piCommand: string | null;
  piConfigured: boolean;
  piDetected: string | null;
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
