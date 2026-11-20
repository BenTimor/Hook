/**
 * The Hook Workspace preview surface, shared by the desktop's side panel and
 * the phone's sheet. Data in, no frame: whoever presents it owns the chrome.
 */
import "./preview.css";

export {
  BoardPreview,
  DocumentPreview,
  TaskPreview,
  WorkspacePreview,
  reportableFrom,
} from "./WorkspacePreview";
export { ReportContentDialog } from "./ReportContentDialog";
export type {
  PreviewTarget,
  WorkspaceBoard,
  WorkspaceColumn,
  WorkspaceComment,
  WorkspaceDocument,
  WorkspacePreviewBody,
  WorkspacePreviewKind,
  WorkspaceTask,
} from "./types";
