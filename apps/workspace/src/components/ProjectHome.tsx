import { useEffect, useState, type ReactNode } from "react";
import {
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  KanbanSquare,
  MoreHorizontal,
  Plus,
  Users,
} from "lucide-react";

import { Dialog, TextFieldDialog } from "@hook/ui";

import type { Folder, Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { MembersPanel } from "./MembersPanel";

type Tab = "boards" | "documents" | "people";
/** `all` shows everything, `unfiled` only what sits outside a folder. */
type Selection = "all" | "unfiled" | string;
type Target = { kind: "board" | "document"; id: string; name: string };

const EMPTY: never[] = [];

/**
 * A project's home: what is inside it and where it lives.
 *
 * Folders are the project's own organization — they belong to nobody in
 * particular, so two people can file the same board differently? No: a folder
 * is part of the project, and everyone sees the same tree. Boards and
 * documents carry a `folderId`; an item whose folder was deleted simply moves
 * back to the top level.
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
  const folders = useWorkspaceStore((state) => state.folders[project.id] ?? EMPTY);
  const createBoard = useWorkspaceStore((state) => state.createBoard);
  const createDocument = useWorkspaceStore((state) => state.createDocument);
  const moveBoard = useWorkspaceStore((state) => state.moveBoard);
  const moveDocument = useWorkspaceStore((state) => state.moveDocument);
  const deleteBoard = useWorkspaceStore((state) => state.deleteBoard);
  const deleteDocument = useWorkspaceStore((state) => state.deleteDocument);
  const createFolder = useWorkspaceStore((state) => state.createFolder);
  const renameFolder = useWorkspaceStore((state) => state.renameFolder);
  const deleteFolder = useWorkspaceStore((state) => state.deleteFolder);

  const [tab, setTab] = useState<Tab>("boards");
  const [selection, setSelection] = useState<Selection>("all");
  const [menu, setMenu] = useState<Target | null>(null);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [boardDialog, setBoardDialog] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [documentDialog, setDocumentDialog] = useState(false);
  const [documentTitle, setDocumentTitle] = useState("");
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [renaming, setRenaming] = useState<Folder | null>(null);
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [confirmingFolder, setConfirmingFolder] = useState<Folder | null>(null);

  const canWrite = project.role !== "viewer";

  // A folder that someone else removed must not leave the view pointing at it.
  useEffect(() => {
    if (selection === "all" || selection === "unfiled") return;
    if (!folders.some((folder) => folder.id === selection)) setSelection("all");
  }, [folders, selection]);

  const known = new Set(folders.map((folder) => folder.id));
  const folderOf = (item: { folderId: string | null }) =>
    item.folderId && known.has(item.folderId) ? item.folderId : null;
  const wanted = selection === "all" ? null : selection === "unfiled" ? undefined : selection;
  const matches = (item: { folderId: string | null }) =>
    selection === "all" ? true : folderOf(item) === (wanted ?? null);

  const visibleBoards = boards.filter(matches);
  const visibleDocuments = documents.filter(matches);
  const target = selection === "all" || selection === "unfiled" ? null : selection;
  const targetName = target ? folders.find((folder) => folder.id === target)?.name : null;

  const countIn = (folderId: string | null) =>
    boards.filter((board) => folderOf(board) === folderId).length +
    documents.filter((document) => folderOf(document) === folderId).length;

  const closeMenus = () => {
    setMenu(null);
    setFolderMenu(null);
  };

  const folderRows = (parentId: string | null, depth: number): ReactNode[] =>
    folders
      .filter((folder) => folder.parentId === parentId)
      .flatMap((folder) => [
        <div
          key={folder.id}
          className="ws-folder-row"
          data-active={selection === folder.id}
          style={{ paddingLeft: 6 + depth * 13 }}
        >
          <button
            className="ws-folder-main"
            onClick={() => {
              setSelection(folder.id);
              setTab((current) => (current === "people" ? "boards" : current));
            }}
          >
            <FolderIcon strokeWidth={1.7} />
            <span>{folder.name}</span>
            <em>{countIn(folder.id)}</em>
          </button>
          {canWrite && (
            <button
              className="ws-folder-more"
              title="Folder options"
              aria-label="Folder options"
              onClick={() => setFolderMenu(folderMenu === folder.id ? null : folder.id)}
            >
              <MoreHorizontal strokeWidth={2} />
            </button>
          )}
          {folderMenu === folder.id && (
            <div className="ws-menu" role="menu">
              <div className="ws-menu-label">{folder.name}</div>
              <button
                role="menuitem"
                onClick={() => {
                  setRenaming(folder);
                  closeMenus();
                }}
              >
                Rename
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setFolderName("");
                  setFolderDialog(true);
                  closeMenus();
                }}
              >
                New folder inside
              </button>
              <div className="ws-menu-sep" />
              <button
                role="menuitem"
                className="ws-menu-danger"
                onClick={() => {
                  setConfirmingFolder(folder);
                  closeMenus();
                }}
              >
                Delete folder
              </button>
            </div>
          )}
        </div>,
        ...folderRows(folder.id, depth + 1),
      ]);

  const tileMenu = (
    item: { id: string; folderId: string | null; label: string },
    kind: Target["kind"],
  ) => {
    const current = folderOf(item);
    return (
      <div className="ws-menu" role="menu">
        <div className="ws-menu-label">Move to</div>
        <button
          role="menuitem"
          data-active={current === null}
          onClick={() => {
            closeMenus();
            if (current !== null) void (kind === "board" ? moveBoard : moveDocument)(item.id, null);
          }}
        >
          No folder
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            role="menuitem"
            data-active={current === folder.id}
            onClick={() => {
              closeMenus();
              if (current !== folder.id) {
                void (kind === "board" ? moveBoard : moveDocument)(item.id, folder.id);
              }
            }}
          >
            {folder.name}
          </button>
        ))}
        <div className="ws-menu-sep" />
        <button
          role="menuitem"
          className="ws-menu-danger"
          onClick={() => {
            closeMenus();
            setConfirming({ kind, id: item.id, name: item.label });
          }}
        >
          Delete {kind}
        </button>
      </div>
    );
  };

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

      <div className="ws-project-body">
        {tab !== "people" && (
          <aside className="ws-folders" aria-label="Folders">
            <div className="ws-folders-head">
              <span>Folders</span>
              {canWrite && (
                <button
                  className="icon-btn"
                  title="New folder"
                  aria-label="New folder"
                  onClick={() => {
                    setFolderName("");
                    setFolderDialog(true);
                  }}
                >
                  <FolderPlus strokeWidth={1.8} />
                </button>
              )}
            </div>
            <button
              className="ws-folder-main ws-folder-all"
              data-active={selection === "all"}
              onClick={() => setSelection("all")}
            >
              <span>Everything</span>
              <em>{boards.length + documents.length}</em>
            </button>
            {folderRows(null, 0)}
            {(boards.length > 0 || documents.length > 0) && (
              <button
                className="ws-folder-main ws-folder-all"
                data-active={selection === "unfiled"}
                onClick={() => setSelection("unfiled")}
              >
                <span>No folder</span>
                <em>{countIn(null)}</em>
              </button>
            )}
            {folders.length === 0 && (
              <p className="ws-folders-note">Folders keep a big project readable.</p>
            )}
          </aside>
        )}

        <div className="ws-content" onClick={() => setFolderMenu(null)}>
          {tab === "boards" && (
            <div className="ws-grid">
              {visibleBoards.map((board) => (
                <div className="ws-tile" key={board.id}>
                  <button className="ws-tile-main" onClick={() => onOpenBoard(board.id)}>
                    <span className="ws-tile-title">{board.name}</span>
                    <span className="ws-tile-note">
                      {board.columns.find((column) => column.type === "status")?.options?.length ??
                        0}{" "}
                      columns
                    </span>
                  </button>
                  {canWrite && (
                    <button
                      className="icon-btn ws-tile-action"
                      title="Board options"
                      aria-label="Board options"
                      onClick={() => setMenu(menu?.id === board.id ? null : { kind: "board", id: board.id, name: board.name })}
                    >
                      <MoreHorizontal strokeWidth={2} />
                    </button>
                  )}
                  {menu?.id === board.id &&
                    tileMenu({ id: board.id, folderId: board.folderId, label: board.name }, "board")}
                </div>
              ))}
              {canWrite && (
                <button className="ws-tile ws-tile-new" onClick={() => setBoardDialog(true)}>
                  <Plus strokeWidth={1.8} />
                  New board
                </button>
              )}
              {visibleBoards.length === 0 && !canWrite && (
                <p className="ws-empty-note">Nothing here yet.</p>
              )}
            </div>
          )}

          {tab === "documents" && (
            <div className="ws-grid">
              {visibleDocuments.map((document) => (
                <div className="ws-tile" key={document.id}>
                  <button
                    className="ws-tile-main"
                    onClick={() => onOpenDocument(document.id)}
                  >
                    <span className="ws-tile-title">{document.title || "Untitled"}</span>
                    <span className="ws-tile-note">Edited {when(document.updatedAt)}</span>
                  </button>
                  {canWrite && (
                    <button
                      className="icon-btn ws-tile-action"
                      title="Document options"
                      aria-label="Document options"
                      onClick={() =>
                        setMenu(
                          menu?.id === document.id
                            ? null
                            : { kind: "document", id: document.id, name: document.title || "Untitled" },
                        )
                      }
                    >
                      <MoreHorizontal strokeWidth={2} />
                    </button>
                  )}
                  {menu?.id === document.id &&
                    tileMenu(
                      {
                        id: document.id,
                        folderId: document.folderId,
                        label: document.title || "Untitled",
                      },
                      "document",
                    )}
                </div>
              ))}
              {canWrite && (
                <button
                  className="ws-tile ws-tile-new"
                  onClick={() => setDocumentDialog(true)}
                >
                  <Plus strokeWidth={1.8} />
                  New document
                </button>
              )}
              {visibleDocuments.length === 0 && !canWrite && (
                <p className="ws-empty-note">Nothing here yet.</p>
              )}
            </div>
          )}

          {tab === "people" && <MembersPanel project={project} />}
        </div>
      </div>

      {menu || folderMenu ? (
        <div className="ws-menu-scrim" onClick={closeMenus} />
      ) : null}

      <TextFieldDialog
        open={boardDialog}
        title="New board"
        description={
          targetName
            ? `Boards hold tasks. This one goes into ${targetName}.`
            : "Boards hold tasks. A new board starts with To do, In progress and Done."
        }
        label="Board name"
        placeholder="Sprint 1"
        value={boardName}
        onChange={setBoardName}
        confirm="Create board"
        onClose={() => setBoardDialog(false)}
        onConfirm={() => {
          const name = boardName.trim();
          if (!name) return;
          void createBoard(project.id, name, target).then((board) => {
            setBoardName("");
            setBoardDialog(false);
            if (board) onOpenBoard(board.id);
          });
        }}
      />

      <TextFieldDialog
        open={documentDialog}
        title="New document"
        description={
          targetName
            ? `A Markdown document. This one goes into ${targetName}.`
            : "A Markdown document. The text is the document, so an agent can read and write it directly."
        }
        label="Title"
        placeholder="Roadmap"
        value={documentTitle}
        onChange={setDocumentTitle}
        confirm="Create document"
        onClose={() => setDocumentDialog(false)}
        onConfirm={() => {
          const title = documentTitle.trim();
          if (!title) return;
          void createDocument(project.id, title, target).then((document) => {
            setDocumentTitle("");
            setDocumentDialog(false);
            if (document) onOpenDocument(document.id);
          });
        }}
      />

      <TextFieldDialog
        open={folderDialog}
        title="New folder"
        description={
          targetName
            ? `A folder inside ${targetName}. Folders only organize boards and documents.`
            : "Folders organize boards and documents inside this project. Everyone in it sees the same tree."
        }
        label="Folder name"
        placeholder="Design"
        value={folderName}
        onChange={setFolderName}
        confirm="Create folder"
        onClose={() => setFolderDialog(false)}
        onConfirm={() => {
          const name = folderName.trim();
          if (!name) return;
          // With a folder selected, a new folder goes inside it.
          void createFolder(project.id, name, target).then(() => {
            setFolderName("");
            setFolderDialog(false);
          });
        }}
      />

      <TextFieldDialog
        open={renaming !== null}
        title="Rename folder"
        label="Folder name"
        value={renaming?.name ?? ""}
        onChange={(value) => setRenaming((folder) => (folder ? { ...folder, name: value } : folder))}
        confirm="Save"
        onClose={() => setRenaming(null)}
        onConfirm={() => {
          const folder = renaming;
          const name = folder?.name.trim();
          if (!folder || !name) return;
          void renameFolder(project.id, folder.id, name);
          setRenaming(null);
        }}
      />

      <Dialog
        open={confirming !== null}
        title={confirming?.kind === "document" ? "Delete this document?" : "Delete this board?"}
        description={
          confirming?.kind === "document"
            ? "The text goes with it, for everyone in the project. This cannot be undone."
            : "Its tasks go with it, for everyone in the project. This cannot be undone."
        }
        onClose={() => setConfirming(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirming(null)}>
              Keep it
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (confirming?.kind === "board") void deleteBoard(confirming.id);
                if (confirming?.kind === "document") void deleteDocument(confirming.id);
                setConfirming(null);
              }}
            >
              Delete
            </button>
          </>
        }
      />

      <Dialog
        open={confirmingFolder !== null}
        title="Delete this folder?"
        description="The boards and documents inside it stay in the project and move to the top level. Only the folder goes."
        onClose={() => setConfirmingFolder(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setConfirmingFolder(null)}>
              Keep it
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (confirmingFolder) {
                  void deleteFolder(project.id, confirmingFolder.id);
                  if (selection === confirmingFolder.id) setSelection("all");
                }
                setConfirmingFolder(null);
              }}
            >
              Delete folder
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
