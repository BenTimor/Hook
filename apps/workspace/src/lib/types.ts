/** The shapes the workspace API returns (camelCase, like every Hook API). */

export type Role = "owner" | "manager" | "editor" | "viewer";

export interface Project {
  id: string;
  name: string;
  description: string;
  /** Account subject of the owner. */
  owner: string;
  /** True when the signed-in account owns it. */
  mine?: boolean;
  role: Role;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface Folder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  position: number;
  updatedAt: number;
  seq: number;
}

export type ColumnType = "status" | "text" | "number" | "date" | "select" | "person";

export interface ColumnOption {
  id: string;
  label: string;
}

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  options?: ColumnOption[];
}

export interface Board {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  description: string;
  columns: Column[];
  position: number;
  updatedAt: number;
  seq: number;
}

export interface Task {
  id: string;
  projectId: string;
  boardId: string;
  title: string;
  description: string;
  status: string;
  assignee: string | null;
  fields: Record<string, unknown>;
  position: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface Comment {
  id: string;
  projectId: string;
  taskId: string;
  author: string;
  authorKind: "user" | "agent";
  viaChatId: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface DocumentMeta {
  id: string;
  projectId: string;
  folderId: string | null;
  title: string;
  /** Present on a single document, absent in a listing. */
  markdown?: string;
  bytes?: number;
  rev: number;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface Member {
  subject: string;
  role: Role;
  joinedAt: number;
  email: string | null;
  name: string | null;
}

export interface Invite {
  id: string;
  projectId: string;
  email: string;
  role: Exclude<Role, "owner">;
  invitedBy: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  createdAt: number;
  respondedAt: number | null;
  seq: number;
  projectName?: string;
}

export type ChangeKind =
  | "project"
  | "folder"
  | "board"
  | "task"
  | "comment"
  | "document"
  | "member"
  | "invite";

export interface Change {
  kind: ChangeKind;
  id: string;
  seq: number;
  deleted: boolean;
  updatedAt: number;
  projectId?: string;
  [key: string]: unknown;
}

export interface ChangesPage {
  cursor: number;
  hasMore: boolean;
  changes: Change[];
}
