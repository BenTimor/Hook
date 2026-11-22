/**
 * The Hook Workspace entities a chat can put in front of the user.
 *
 * They live here rather than in one app because the desktop's side panel and
 * the phone's sheet draw the same three things from the same JSON. The backend
 * hands `workspace_preview` straight through (`crates/hook-core/src/workspace.rs`),
 * so these shapes are the wire format, not a view model.
 */

export interface WorkspaceTask {
  id: string;
  projectId: string;
  boardId: string;
  title: string;
  description: string;
  status: string;
  assignee?: string | null;
  fields?: Record<string, unknown>;
  updatedAt: number;
}

export interface WorkspaceDocument {
  id: string;
  projectId: string;
  title: string;
  markdown: string;
  /** The document's own text direction, set in Workspace or by an agent. */
  direction?: "ltr" | "rtl";
  rev: number;
  updatedAt: number;
}

export interface WorkspaceColumn {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

export interface WorkspaceBoard {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  columns: WorkspaceColumn[];
}

export interface WorkspaceComment {
  id: string;
  author: string;
  authorKind: "user" | "agent";
  viaChatId?: string | null;
  body: string;
  createdAt: number;
}

/** What `workspace_preview` can show. A page preview is not one of these. */
export type WorkspacePreviewKind = "document" | "task" | "board";

/** Everything one preview can carry, exactly as the tool returned it. */
export interface WorkspacePreviewBody {
  kind: WorkspacePreviewKind;
  document?: WorkspaceDocument;
  task?: WorkspaceTask;
  comments?: WorkspaceComment[];
  board?: WorkspaceBoard;
  tasks?: WorkspaceTask[];
}

/**
 * What a person can flag from a preview: the entity, and the words a reviewer
 * would need to see. Comments are other people's writing, so this path exists
 * beside the AI-output report rather than inside it.
 */
export interface PreviewTarget {
  kind: WorkspacePreviewKind;
  id: string;
  projectId?: string;
  title: string;
  excerpt: string;
}
