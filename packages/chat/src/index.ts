/** The chat surface every Hook product can embed. */
export { Markdown } from "./Markdown";
export { CodeBlock } from "./CodeBlock";
export { highlight } from "./highlight";
export { openExternal } from "./open";
export { CompactionItem } from "./CompactionItem";
export { MessageItem } from "./MessageItem";
export { Thread } from "./Thread";
export { WorkGroup, ReasoningStepView, ToolStepView } from "./WorkSteps";
export { buildBlocks, toolStepFromTranscript } from "./turns";
export { Composer } from "./Composer";
export { ReportDialog } from "./ReportDialog";
export { REPORT_REASONS } from "./ReportDialog";
export { Lightbox, MessageImages } from "./images";
export type { ChatAttachment, LightboxProps, MessageImagesProps } from "./images";
export {
  BoardPreview,
  DocumentPreview,
  TaskPreview,
  WorkspacePreview,
  previewDirection,
  reportableFrom,
} from "./preview";
export { ReportContentDialog } from "./preview";
export type {
  PreviewTarget,
  WorkspaceBoard,
  WorkspaceColumn,
  WorkspaceComment,
  WorkspaceDocument,
  WorkspacePreviewBody,
  WorkspacePreviewKind,
  WorkspaceTask,
} from "./preview";
export { ChatDock } from "./ChatDock";
export { MachinesSection } from "./MachinesSection";
export type { Machine, MachinesSectionProps } from "./MachinesSection";
export { greeting } from "./greeting";
export type { MessageItemProps } from "./MessageItem";
export type { ThreadProps } from "./Thread";
export type {
  ReasoningStep,
  TextStep,
  ToolStep,
  WorkStep,
} from "./WorkSteps";
export type {
  AnswerBlock,
  AnswerPart,
  AnswerTextPart,
  AnswerWorkPart,
  CompactionBlock,
  MessageBlock,
  ThreadBlock,
} from "./turns";
export type { ComposerProps } from "./Composer";
export { RemoteChatDialog } from "./RemoteChatDialog";
export type {
  RemoteMachine,
  RemoteProjectOption,
} from "./RemoteChatDialog";
export type { ReportInput, ReportReason, TranscriptMessage } from "./ReportDialog";
export type {
  ChatTransport,
  DockChat,
  DockEvent,
  DockMessage,
  DockReport,
} from "./ChatDock";
export type {
  ChatCompaction,
  ChatMessage,
  ChatToolCall,
  DraftImage,
  SlashCommand,
} from "./types";
