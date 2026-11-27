/**
 * The Hook Workspace preview surface, shared by the desktop's side panel and
 * the phone's sheet. Data in, no frame: whoever presents it owns the chrome.
 */
import "./preview.css";

export {
  BoardPreview,
  BrainstormPreview,
  DocumentPreview,
  RoadmapPreview,
  TaskPreview,
  WorkspacePreview,
  previewDirection,
  reportableFrom,
} from "./WorkspacePreview";
export { ReportContentDialog } from "./ReportContentDialog";
export type {
  PreviewTarget,
  WorkspaceBoard,
  WorkspaceBrainstorm,
  WorkspaceBrainstormIdea,
  WorkspaceColumn,
  WorkspaceComment,
  WorkspaceDocument,
  WorkspaceMilestone,
  WorkspacePreviewBody,
  WorkspacePreviewKind,
  WorkspaceRoadmap,
  WorkspaceTask,
} from "./types";
