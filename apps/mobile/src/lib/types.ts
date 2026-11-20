import type { ChatAttachment, ChatMessage } from "@hook/chat";

/**
 * The phone's view of the backend.
 *
 * Only what this product can actually do: `hook-core` is compiled with
 * `Capabilities::mobile()`, so there are no agents, no project folders and no
 * page preview — and therefore no types for them here. Everything below is the
 * same JSON the desktop's `apps/chat/src/lib/types.ts` describes, trimmed.
 */

export type Role = "user" | "assistant" | "system" | "tool";

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
}

export interface SettingsView {
  projectsDir: string;
  advancedMode: boolean;
}

export interface SyncView {
  enabled: boolean;
  state: "off" | "idle" | "syncing" | "error";
  cursor: number;
  pending: number;
  lastSyncAt: number;
  message: string | null;
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
  kind?: WorkspacePreviewKind;
  document?: import("@hook/chat").WorkspaceDocument;
  task?: import("@hook/chat").WorkspaceTask;
  comments?: import("@hook/chat").WorkspaceComment[];
  board?: import("@hook/chat").WorkspaceBoard;
  tasks?: import("@hook/chat").WorkspaceTask[];
  title?: string;
  open: boolean;
}

export interface PreviewClosed {
  active: false;
  chatId: string;
}

export type PreviewEvent = PreviewView | PreviewClosed;
