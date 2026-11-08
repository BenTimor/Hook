export type Role = "user" | "assistant";
export type MessageStatus = "complete" | "streaming" | "error" | "aborted";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
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

export type StreamEvent =
  | { kind: "started"; messages: Message[]; meta: ChatMeta }
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "done"; messages: Message[]; meta: ChatMeta }
  | { kind: "error"; message: string; messages: Message[]; meta: ChatMeta };
