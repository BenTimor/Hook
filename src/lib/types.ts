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
  /** Content address used by the sync service. */
  sha256?: string;
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
  /** "chatgpt" or "claude" when this chat came from an import. */
  source?: string;
  /** The conversation id at the source. */
  sourceId?: string;
  /** The source's own updatedAt at the last import. */
  sourceUpdatedAt?: number;
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

/** What the release index says about this build. */
export interface UpdateInfo {
  current: string;
  latest: string;
  minimum: string;
  /** direct = Hook installs it; store = Microsoft Store installs it. */
  channel: "direct" | "store";
  /** A newer build exists. */
  available: boolean;
  /** The running build is below the supported floor and must update. */
  required: boolean;
  notes: string | null;
  builtAt: string | null;
  commit: string | null;
  size: number | null;
}

/** Reporting inappropriate AI output (Microsoft Store policy 11.16). */
export type ReportReason =
  | "harmful"
  | "sexual"
  | "violence"
  | "hate"
  | "other";

export interface ReportMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ReportRequest {
  chatId: string;
  messageId: string;
  reason: ReportReason;
  note: string | null;
  content: string;
  /** Null unless the user ticks "include the whole conversation". */
  transcript: ReportMessage[] | null;
}

/** Conversation and project sync, as shown in Settings. */
export interface SyncView {
  enabled: boolean;
  state: "off" | "idle" | "syncing" | "error";
  cursor: number;
  pending: number;
  lastSyncAt: number;
  message: string | null;
}

export interface SyncEvent {
  chats: boolean;
  projects: boolean;
  at: number;
}

/** Download progress for an in-app update. */
export interface UpdateEvent {
  phase: "downloading" | "installing";
  received: number;
  total: number | null;
}

/** Desktop sign-in state. `pending` carries the code shown in the login window. */
export interface AuthView {
  signedIn: boolean;
  state: "signed_out" | "pending" | "signed_in";
  email: string | null;
  name: string | null;
  userCode: string | null;
  verificationUrl: string | null;
  message: string | null;
}

export interface Project {
  /** Stable account id; the folder name and path are local to this machine. */
  id: string;
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

/**
 * Importing a conversation export downloaded from ChatGPT or Claude. The file
 * is read once to preview the counts, then again from a cache to write it.
 */
export interface ImportPreview {
  source: string;
  /** "ChatGPT" or "Claude", for the confirmation line. */
  vendor: string;
  file: string;
  conversations: number;
  /** Chats this import would add. */
  new: number;
  /** Already imported, with a newer version in this file. */
  updated: number;
  /** Already imported and identical. */
  unchanged: number;
  /** Already imported and edited in Hook since. Left alone. */
  keptLocal: number;
  messages: number;
  warnings: string[];
}

export interface ImportSummary {
  source: string;
  vendor: string;
  imported: number;
  updated: number;
  unchanged: number;
  keptLocal: number;
  messages: number;
  /** Chats that were written, newest first. */
  chatIds: string[];
  warnings: string[];
}

/** Progress while the conversations are written; emitted as `hook://import`. */
export interface ImportProgress {
  phase: "importing" | "done";
  source: string;
  done: number;
  total: number;
}
