/** The chat surface every Hook product can embed. */
export { Markdown } from "./Markdown";
export { CodeBlock } from "./CodeBlock";
export { highlight } from "./highlight";
export { openExternal } from "./open";
export { MessageItem } from "./MessageItem";
export { Thread } from "./Thread";
export { Composer } from "./Composer";
export { ReportDialog } from "./ReportDialog";
export { ChatDock } from "./ChatDock";
export type { MessageItemProps } from "./MessageItem";
export type { ThreadProps } from "./Thread";
export type { ComposerProps } from "./Composer";
export type { ReportInput, ReportReason, TranscriptMessage } from "./ReportDialog";
export type {
  ChatTransport,
  DockChat,
  DockEvent,
  DockMessage,
  DockReport,
} from "./ChatDock";
export type { ChatMessage, DraftImage } from "./types";
