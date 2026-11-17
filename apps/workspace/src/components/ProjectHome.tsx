import { useState } from "react";
import { FileText, KanbanSquare, Plus, Users } from "lucide-react";

import { Dialog, TextFieldDialog } from "@hook/ui";

import type { Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { MembersPanel } from "./MembersPanel";

type Tab = "boards" | "documents" | "people";

const EMPTY: never[] = [];


/**
 * A project's home: what is inside it, and the three things you can make.
 * Folders are not shown yet — the API has them, and they arrive when a project
 * has enough in it to need them.
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
  const createBoard = useWorkspaceStore((state) => state.createBoard);
  const createDocument = useWorkspaceStore((state) => state.createDocument);
  const deleteBoard = useWorkspaceStore((state) => state.deleteBoard);

  const [tab, setTab] = useState<Tab>("boards");
  const [boardName, setBoardName] = useState("");
  const [boardDialog, setBoardDialog] = useState(false);
  const [documentTitle, setDocumentTitle] = useState("");
  const [documentDialog, setDocumentDialog] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const canWrite = project.role !== "viewer";

  return (
    <div className="ws-project">
      <header className="ws-project-head">
        <div>
          <h1>{project.name}</h1>
          {project.description ? <p>{project.description}</p> : null}
        </div>
      </header>

      <nav className="ws-tabs" role="tablist">
        <button role="tab" data-active={tab === "boards"} onClick={() => setTab("boards")}>
          <KanbanSquare /> Boards
          <span>{boards.length}</span>
        </button>
        <button role="tab" data-active={tab === "documents"} onClick={() => setTab("documents")}>
          <FileText /> Documents
          <span>{documents.length}</span>
        </button>
        <button role="tab" data-active={tab === "people"} onClick={() => setTab("people")}>
          <Users /> People
          <span>{members.length}</span>
        </button>
      </nav>

      {tab === "boards" && (
        <div className="ws-grid">
          {boards.map((board) => (
            <div className="ws-tile" key={board.id}>
              <button className="ws-tile-main" onClick={() => onOpenBoard(board.id)}>
                <span className="ws-tile-title">{board.name}</span>
                <span className="ws-tile-note">
                  {board.columns.find((column) => column.type === "status")?.options?.length ?? 0}{" "}
                  columns
                </span>
              </button>
              {canWrite && (
                <button
                  className="icon-btn ws-tile-action"
                  title="Delete board"
                  onClick={() => setConfirming(board.id)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {canWrite && (
            <button className="ws-tile ws-tile-new" onClick={() => setBoardDialog(true)}>
              <Plus strokeWidth={1.8} />
              New board
            </button>
          )}
          {boards.length === 0 && !canWrite && (
            <p className="ws-empty-note">This project has no boards yet.</p>
          )}
        </div>
      )}

      {tab === "documents" && (
        <div className="ws-grid">
          {documents.map((document) => (
            <button
              className="ws-tile ws-tile-main"
              key={document.id}
              onClick={() => onOpenDocument(document.id)}
            >
              <span className="ws-tile-title">{document.title || "Untitled"}</span>
              <span className="ws-tile-note">Edited {when(document.updatedAt)}</span>
            </button>
          ))}
          {canWrite && (
            <button className="ws-tile ws-tile-new" onClick={() => setDocumentDialog(true)}>
              <Plus strokeWidth={1.8} />
              New document
            </button>
          )}
          {documents.length === 0 && !canWrite && (
            <p className="ws-empty-note">This project has no documents yet.</p>
          )}
        </div>
      )}

      {tab === "people" && <MembersPanel project={project} />}

      <TextFieldDialog
        open={boardDialog}
        title="New board"
        description="Boards hold tasks. A new board starts with To do, In progress and Done."
        label="Board name"
        placeholder="Sprint 1"
        value={boardName}
        onChange={setBoardName}
        confirm="Create board"
        onClose={() => setBoardDialog(false)}
        onConfirm={() => {
          const name = boardName.trim();
          if (!name) return;
          void createBoard(project.id, name).then((board) => {
            setBoardName("");
            setBoardDialog(false);
            if (board) onOpenBoard(board.id);
          });
        }}
      />

      <TextFieldDialog
        open={documentDialog}
        title="New document"
        description="A Markdown document. The text is the document, so an agent can read and write it directly."
        label="Title"
        placeholder="Roadmap"
        value={documentTitle}
        onChange={setDocumentTitle}
        confirm="Create document"
        onClose={() => setDocumentDialog(false)}
        onConfirm={() => {
          const title = documentTitle.trim();
          if (!title) return;
          void createDocument(project.id, title).then((document) => {
            setDocumentTitle("");
            setDocumentDialog(false);
            if (document) onOpenDocument(document.id);
          });
        }}
      />

      <Dialog
        open={confirming !== null}
        title="Delete this board?"
        description="Its tasks go with it, for everyone in the project. This cannot be undone."
        onClose={() => setConfirming(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirming(null)}>
              Keep it
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (confirming) void deleteBoard(confirming);
                setConfirming(null);
              }}
            >
              Delete board
            </button>
          </>
        }
      />
    </div>
  );
}

export function when(timestamp: number): string {
  if (!timestamp) return "just now";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}
