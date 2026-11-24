import type { ChatAttachment, ChatMessage } from "@hook/chat";

export type { SlashCommand } from "@hook/chat";

/**
 * The phone's view of the backend.
 *
 * Only what this product can actually do: `hook-core` is compiled with
 * `Capabilities::mobile()`, so there are no agents, no project folders and no
 * page preview — and therefore no types for them here. Everything below is the
 * same JSON the desktop's `apps/chat/src/lib/types.ts` describes, trimmed.
 */

export type Role = "user" | "assistant" | "system" | "tool" | "compaction";

/** A message as the store writes it; `ChatMessage` is the part the surface needs. */
export interface Message extends ChatMessage {
  createdAt?: number;
  usage?: { promptTokens: number; completionTokens: number };
  attachments?: ChatAttachment[];
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
  /** "coding" for a conversation with a directly-driven agent. */
  kind?: "coding";
  /** The folder and session on the owner; absent on a cached copy. */
  projectPath?: string;
  sessionId?: string;
  /** The machine that owns the chat; `remote` marks a cached copy. */
  deviceId?: string;
  deviceName?: string;
  remote?: boolean;
  stubState?: "idle" | "running" | "needs_input" | "error" | string;
}

/** What a host offers as a place to start a direct coding chat. */
export interface RemoteProject {
  project: string;
  description?: string | null;
  git?: boolean;
}

/** One folder on a host, as `remote_folders` lists it. */
export interface RemoteFolder {
  name: string;
  path: string;
  /** This machine has it starred, so the picker draws a filled star. */
  pinned?: boolean;
}

/**
 * One level of a host's folders. `path` is null at the top, where the entries
 * are the folders starred on that machine followed by the places browsing
 * starts from: home, the projects folder, the drives.
 */
export interface RemoteFolders {
  path: string | null;
  parent: string | null;
  entries: RemoteFolder[];
  /** The level held more folders than one answer may carry. */
  truncated: boolean;
}

/** Where a remote coding chat should start on its host. */
export interface RemoteTarget {
  project?: string;
  folder?: string;
}

export interface Chat {
  meta: ChatMeta;
  messages: Message[];
}

export interface AppInfo {
  version: string;
  product?: string;
}

export interface AuthView {
  signedIn: boolean;
  state: "signed_out" | "pending" | "signed_in";
  email: string | null;
  name: string | null;
  userCode: string | null;
  verificationUrl: string | null;
  message: string | null;
  /** `free`, `plus` or `pro`. Null on the browser demo. */
  plan: string | null;
  /** The account-wide cloud-sync switch. */
  cloudSync: boolean | null;
  /** The free plan's rolling message window. Null on a paid plan. */
  quota: Quota | null;
}

/** The free plan's 24-hour message allowance. */
export interface Quota {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
}

/** A model endpoint the user brought themselves, for this product only. */
export interface CustomProvider {
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

export interface SettingsView {
  projectsDir: string;
  advancedMode: boolean;
  plan: string | null;
  cloudSync: boolean;
  customProvider: CustomProvider | null;
}

export interface SyncView {
  enabled: boolean;
  available: boolean;
  reason: "free" | "off" | null;
  state: "off" | "idle" | "syncing" | "error";
  cursor: number;
  pending: number;
  lastSyncAt: number;
  message: string | null;
}

/** What the background sync applied from the account. */
export interface SyncEvent {
  chats: boolean;
  projects: boolean;
  memory: boolean;
  /** The personal model endpoint arrived from another device. */
  settings?: boolean;
  at: number;
}

/** One machine the account knows, merged with its live connection state. */
export interface DeviceView {
  id: string;
  name: string;
  kind: "desktop" | "headless" | "mobile" | string;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  product: string | null;
  canHost: boolean;
  online: boolean;
  hostOnline: boolean;
  role: string;
  remoteAllowed: boolean;
  lastSeen: string | null;
  capabilities: Record<string, unknown> | null;
  specs: { cpuCores?: number; projects?: number } | null;
}

/** The relay's view: whether this phone is connected, and the account's machines. */
export interface DevicesView {
  state: "signedOut" | "connecting" | "online" | "refused" | "offline";
  message: string | null;
  error: string | null;
  selfId: string;
  selfName: string;
  devices: DeviceView[];
}

export type StreamEvent =
  | { kind: "started"; messages: Message[]; meta: ChatMeta }
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "activity"; label: string | null }
  | { kind: "done"; messages: Message[] }
  | { kind: "error"; message: string };

export type WorkspacePreviewKind = "document" | "task" | "board";

/**
 * What the preview sheet is showing. `page` (an HTML file served from a project
 * folder) is deliberately absent: this build has no folder to serve from.
 */
export interface PreviewView {
  active: true;
  chatId: string;
  /** "page" is an HTML file on a machine; the rest are Workspace data. */
  kind?: "page" | WorkspacePreviewKind;
  document?: import("@hook/chat").WorkspaceDocument;
  task?: import("@hook/chat").WorkspaceTask;
  comments?: import("@hook/chat").WorkspaceComment[];
  board?: import("@hook/chat").WorkspaceBoard;
  tasks?: import("@hook/chat").WorkspaceTask[];
  title?: string;
  /** The remote ticket URL for a page the machine is serving. */
  url?: string;
  file?: string;
  version?: number;
  waiting?: boolean;
  live?: boolean;
  /** The machine that owns the page, when this view came over the relay. */
  deviceId?: string;
  deviceName?: string;
  remote?: boolean;
  open: boolean;
}

export interface PreviewClosed {
  active: false;
  chatId: string;
}

export type PreviewEvent = PreviewView | PreviewClosed;
