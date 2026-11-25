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

export type ColumnType =
  | "status"
  | "text"
  | "longtext"
  | "number"
  | "checkbox"
  | "select"
  | "multiselect"
  | "person"
  | "date"
  | "datetime"
  | "daterange"
  | "progress"
  | "url"
  | "email"
  | "phone";

export type StatusColor =
  | "slate"
  | "green"
  | "blue"
  | "amber"
  | "red"
  | "purple"
  | "teal"
  | "pink";

export interface ColumnOption {
  id: string;
  label: string;
  color?: StatusColor;
}

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  options?: ColumnOption[];
  hidden?: boolean;
}

export interface Board {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  description: string;
  columns: Column[];
  view?: "table" | "board";
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
  /** The first assignee, mirrored for older clients and agent tools. */
  assignee: string | null;
  /** Everyone the task is assigned to, in the order they were added. */
  assignees: string[];
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

export interface Roadmap {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  description: string;
  position: number;
  updatedAt: number;
  seq: number;
}

export interface Brainstorm {
  id: string;
  projectId: string;
  folderId: string | null;
  name: string;
  description: string;
  position: number;
  updatedAt: number;
  seq: number;
}

export interface BrainstormIdea {
  id: string;
  projectId: string;
  brainstormId: string;
  text: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export type MilestoneStatus = "planned" | "active" | "done";

export interface Milestone {
  id: string;
  projectId: string;
  roadmapId: string;
  title: string;
  description: string;
  dueDate: string | null;
  status: MilestoneStatus;
  position: number;
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
  inviterName?: string | null;
  inviterEmail?: string | null;
}

export type ChangeKind =
  | "project"
  | "folder"
  | "board"
  | "task"
  | "comment"
  | "document"
  | "roadmap"
  | "milestone"
  | "brainstorm"
  | "brainstorm_idea"
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
