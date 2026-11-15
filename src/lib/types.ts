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

export type PlanStepStatus = "pending" | "active" | "done";

/** One item of the checklist the user watches while a coding agent works. */
export interface PlanStep {
  title: string;
  status: PlanStepStatus;
  /** Epoch ms when this step was first seen in progress. */
  startedAt?: number;
  /** Epoch ms when this step crossed into done. */
  finishedAt?: number;
}

/** The UI-facing shape of a coding-agent run. */
export interface AgentSummary {
  id: string;
  chatId: string;
  title: string;
  project: string;
  state: string;
  steps: number;
  plan: PlanStep[];
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  waiting: boolean;
}

export interface AgentsOverview {
  working: number;
  live: number;
  agents: AgentSummary[];
}

/** One HTML page shown in the right-side preview panel. */
export interface PreviewView {
  active: true;
  chatId: string;
  project?: string;
  file?: string;
  title?: string;
  /** Loopback URL of the page, served for as long as the preview lives. */
  url?: string;
  /** Bumped by the backend whenever the project changes. */
  version: number;
  /** The first time a run shows a preview the panel should open. */
  open: boolean;
  /** The page file has not been written yet. */
  waiting: boolean;
  /** The run is still working, so the page refreshes itself as files change. */
  live: boolean;
}

/** The preview ended: the chat was deleted, another page replaced this one, or
 * the app is quitting. A finished coding-agent run leaves the panel open. */
export interface PreviewClosed {
  active: false;
  chatId: string;
}

export type PreviewEvent = PreviewView | PreviewClosed;

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
