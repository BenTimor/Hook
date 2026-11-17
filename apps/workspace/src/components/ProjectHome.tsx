import { FileText, FolderPlus, KanbanSquare, Plus } from "lucide-react";
import { useState } from "react";

import type { Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { CreateItemDialog, type CreateRequest } from "./CreateItem";
import { MembersPanel } from "./MembersPanel";
import { when } from "./when";

const EMPTY: never[] = [];
const WRITE_ROLES = ["owner", "manager", "editor"];

/**
 * A project, before you pick something inside it.
 *
 * The tree on the left is the navigation now, so this page is the overview:
 * what the project is, who is in it, and what was touched last. Boards and
 * documents are opened from the tree or from these cards.
 */
export function ProjectHome({
  project,
  onOpenBoard,
  onOpenDocument,
}: {
  project: Project;
  onOpenBoard: (id: string) => void;
  onOpenDocument: (id: string) => void;
}) {
  const boards = useWorkspaceStore((state) => state.boards[project.id] ?? EMPTY);
  const documents = useWorkspaceStore((state) => state.documents[project.id] ?? EMPTY);
  const members = useWorkspaceStore((state) => state.members[project.id] ?? EMPTY);

  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const canWrite = WRITE_ROLES.includes(project.role);

  const recentBoards = [...boards]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);
  const recentDocuments = [...documents]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);

  return (
    <div className="ws-overview">
      <header className="ws-overview-head">
        <span className="ws-project-badge ws-project-badge-lg" aria-hidden="true">
          {project.name.trim().charAt(0).toUpperCase() || "H"}
        </span>
        <div className="ws-overview-who">
          <h1>{project.name}</h1>
          <p>{project.description || "No description yet."}</p>
          <div className="ws-overview-meta">
            <span className="ws-pill" data-role={project.role}>
              {project.role}
            </span>
            <span>
              {boards.length} {boards.length === 1 ? "board" : "boards"}
            </span>
            <span>
              {documents.length} {documents.length === 1 ? "document" : "documents"}
            </span>
            <span>
              {members.length} {members.length === 1 ? "person" : "people"}
            </span>
          </div>
        </div>
      </header>

      {canWrite ? (
        <div className="ws-overview-actions">
          <button
            className="ws-action"
            onClick={() => setCreating({ kind: "board", projectId: project.id, folderId: null })}
          >
            <KanbanSquare strokeWidth={1.8} />
            New board
          </button>
          <button
            className="ws-action"
            onClick={() => setCreating({ kind: "document", projectId: project.id, folderId: null })}
          >
            <FileText strokeWidth={1.8} />
            New document
          </button>
          <button
            className="ws-action"
            onClick={() => setCreating({ kind: "folder", projectId: project.id, folderId: null })}
          >
            <FolderPlus strokeWidth={1.8} />
            New folder
          </button>
        </div>
      ) : null}

      <div className="ws-overview-grid">
        <section className="ws-overview-section">
          <header>
            <h2>Boards</h2>
            <span>{boards.length}</span>
          </header>
          {recentBoards.length === 0 ? (
            <p className="ws-overview-empty">No boards yet.</p>
          ) : (
            <div className="ws-cards">
              {recentBoards.map((board) => (
                <button className="ws-item-card" key={board.id} onClick={() => onOpenBoard(board.id)}>
                  <KanbanSquare strokeWidth={1.7} />
                  <span className="ws-item-card-main">
                    <span className="ws-item-card-title">{board.name}</span>
                    <span className="ws-item-card-note">
                      {board.columns.length} columns · edited {when(board.updatedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="ws-overview-section">
          <header>
            <h2>Documents</h2>
            <span>{documents.length}</span>
          </header>
          {recentDocuments.length === 0 ? (
            <p className="ws-overview-empty">No documents yet.</p>
          ) : (
            <div className="ws-cards">
              {recentDocuments.map((document) => (
                <button
                  className="ws-item-card"
                  key={document.id}
                  onClick={() => onOpenDocument(document.id)}
                >
                  <FileText strokeWidth={1.7} />
                  <span className="ws-item-card-main">
                    <span className="ws-item-card-title">
                      {document.title || "Untitled"}
                    </span>
                    <span className="ws-item-card-note">edited {when(document.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="ws-overview-section ws-overview-people">
        <header>
          <h2>People</h2>
          <span>{members.length}</span>
        </header>
        <MembersPanel project={project} />
      </section>

      {canWrite && boards.length === 0 && documents.length === 0 ? (
        <div className="ws-overview-start">
          <p>An empty project. Start with a board for the work, or a document for the thinking.</p>
          <button
            className="btn btn-primary"
            onClick={() => setCreating({ kind: "board", projectId: project.id, folderId: null })}
          >
            <Plus /> Create the first board
          </button>
        </div>
      ) : null}

      <CreateItemDialog request={creating} onClose={() => setCreating(null)} />
    </div>
  );
}
