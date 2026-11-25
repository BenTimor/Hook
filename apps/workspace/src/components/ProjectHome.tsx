import {
  FileText,
  FolderPlus,
  KanbanSquare,
  Lightbulb,
  Plus,
  Route,
  Star,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Dialog } from "@hook/ui";

import type { Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { CreateItemDialog, type CreateRequest } from "./CreateItem";
import { MembersPanel } from "./MembersPanel";
import { when } from "./when";
import { QuickPreview } from "./QuickPreview";
import {
  readShortcuts,
  writeShortcuts,
  type Shortcut,
} from "../lib/projectShortcuts";

const EMPTY: never[] = [];
const WRITE_ROLES = ["owner", "manager", "editor"];

/**
 * A project, before you pick something inside it.
 *
 * The tree on the left is the navigation now, so this page is the overview:
 * what the project is, who is in it, and what was touched last. Boards,
 * documents and roadmaps are opened from the tree or from these cards.
 */
export function ProjectHome({
  project,
  accountEmail,
  onOpenBoard,
  onOpenDocument,
  onOpenRoadmap,
  onOpenBrainstorm,
}: {
  project: Project;
  accountEmail: string | null;
  onOpenBoard: (id: string) => void;
  onOpenDocument: (id: string) => void;
  onOpenRoadmap: (id: string) => void;
  onOpenBrainstorm: (id: string) => void;
}) {
  const boards = useWorkspaceStore(
    (state) => state.boards[project.id] ?? EMPTY,
  );
  const documents = useWorkspaceStore(
    (state) => state.documents[project.id] ?? EMPTY,
  );
  const roadmaps = useWorkspaceStore(
    (state) => state.roadmaps[project.id] ?? EMPTY,
  );
  const brainstorms = useWorkspaceStore(
    (state) => state.brainstorms[project.id] ?? EMPTY,
  );
  const milestones = useWorkspaceStore(
    (state) => state.milestones[project.id] ?? EMPTY,
  );
  const members = useWorkspaceStore(
    (state) => state.members[project.id] ?? EMPTY,
  );

  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(() =>
    readShortcuts(accountEmail, project.id),
  );
  const canWrite = WRITE_ROLES.includes(project.role);

  const recentBoards = [...boards]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);
  const recentDocuments = [...documents]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);
  const recentRoadmaps = [...roadmaps]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);
  const recentBrainstorms = [...brainstorms]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 4);

  const items = [
    ...boards.map((board) => ({
      kind: "board" as const,
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
    })),
    ...documents.map((document) => ({
      kind: "document" as const,
      id: document.id,
      name: document.title || "Untitled",
      updatedAt: document.updatedAt,
    })),
  ];
  const resolveItems = (refs: Shortcut[]) =>
    refs.flatMap((ref) => {
      const item = items.find(
        (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
      );
      return item ? [item] : [];
    });
  const isFavorite = (item: Shortcut) =>
    shortcuts.favorites.some(
      (entry) => entry.kind === item.kind && entry.id === item.id,
    );
  const favorites = resolveItems(shortcuts.favorites);
  const opened = resolveItems(shortcuts.recent)
    .filter((item) => !isFavorite(item))
    .slice(0, 4);
  const edited = [...items]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(
      (item) =>
        !isFavorite(item) &&
        !opened.some(
          (entry) => entry.kind === item.kind && entry.id === item.id,
        ),
    )
    .slice(0, 4);
  const toggleFavorite = (item: Shortcut) => {
    const favorites = isFavorite(item)
      ? shortcuts.favorites.filter(
          (entry) => entry.kind !== item.kind || entry.id !== item.id,
        )
      : [...shortcuts.favorites, { kind: item.kind, id: item.id }];
    const next = { ...shortcuts, favorites };
    setShortcuts(next);
    writeShortcuts(accountEmail, project.id, next);
  };
  const shortcutList = (list: typeof items, empty: string) =>
    list.length ? (
      <div className="ws-quick-tiles">
        {list.map((item) => (
          <div className="ws-quick-tile" key={`${item.kind}:${item.id}`}>
            <button
              className="ws-quick-tile-open"
              onClick={() =>
                item.kind === "board"
                  ? onOpenBoard(item.id)
                  : onOpenDocument(item.id)
              }
            >
              <QuickPreview
                kind={item.kind}
                id={item.id}
                updatedAt={item.updatedAt}
              />
              <span className="ws-quick-tile-label">
                {item.kind === "board" ? <KanbanSquare /> : <FileText />}
                <span className="ws-item-card-main">
                  <span className="ws-item-card-title">{item.name}</span>
                  <span className="ws-item-card-note">
                    {item.kind === "board" ? "Board" : "Document"} ֲ· edited{" "}
                    {when(item.updatedAt)}
                  </span>
                </span>
              </span>
            </button>
            <button
              className="ws-favorite ws-quick-favorite"
              aria-label={`${isFavorite(item) ? "Remove" : "Add"} ${item.name} ${isFavorite(item) ? "from" : "to"} favorites`}
              aria-pressed={isFavorite(item)}
              disabled={!accountEmail}
              title={
                accountEmail ? "Toggle favorite" : "Sign in to save favorites"
              }
              onClick={() => toggleFavorite(item)}
            >
              <Star />
            </button>
          </div>
        ))}
      </div>
    ) : (
      <p className="ws-overview-empty">{empty}</p>
    );

  return (
    <div className="ws-overview">
      <header className="ws-overview-head">
        <span
          className="ws-project-badge ws-project-badge-lg"
          aria-hidden="true"
        >
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
              {documents.length}{" "}
              {documents.length === 1 ? "document" : "documents"}
            </span>
            <span>
              {members.length} {members.length === 1 ? "person" : "people"}
            </span>
          </div>
        </div>
        <button
          className="ws-action ws-people-button"
          onClick={() => setPeopleOpen(true)}
        >
          <Users /> People <span>{members.length}</span>
        </button>
      </header>

      {canWrite ? (
        <div className="ws-overview-actions">
          <button
            className="ws-action"
            onClick={() =>
              setCreating({
                kind: "board",
                projectId: project.id,
                folderId: null,
              })
            }
          >
            <KanbanSquare strokeWidth={1.8} />
            New board
          </button>
          <button
            className="ws-action"
            onClick={() =>
              setCreating({
                kind: "document",
                projectId: project.id,
                folderId: null,
              })
            }
          >
            <FileText strokeWidth={1.8} />
            New document
          </button>
          <button
            className="ws-action"
            onClick={() =>
              setCreating({
                kind: "brainstorm",
                projectId: project.id,
                folderId: null,
              })
            }
          >
            <Lightbulb strokeWidth={1.8} />
            New brainstorm
          </button>
          <button
            className="ws-action"
            onClick={() =>
              setCreating({
                kind: "folder",
                projectId: project.id,
                folderId: null,
              })
            }
          >
            <FolderPlus strokeWidth={1.8} />
            New folder
          </button>
        </div>
      ) : null}

      <div className="ws-overview-grid">
        <section className="ws-overview-section ws-overview-work">
          <header>
            <h2>Boards</h2>
            <span>{boards.length}</span>
            {canWrite && (
              <button
                className="ws-section-add"
                aria-label="Create board"
                title="Create board"
                onClick={() =>
                  setCreating({
                    kind: "board",
                    projectId: project.id,
                    folderId: null,
                  })
                }
              >
                <Plus />
              </button>
            )}
          </header>
          {recentBoards.length === 0 ? (
            <p className="ws-overview-empty">No boards yet.</p>
          ) : (
            <div className="ws-cards">
              {recentBoards.map((board) => (
                <div className="ws-shortcut-row" key={board.id}>
                  <button
                    className="ws-item-card"
                    onClick={() => onOpenBoard(board.id)}
                  >
                    <KanbanSquare strokeWidth={1.7} />
                    <span className="ws-item-card-main">
                      <span className="ws-item-card-title">{board.name}</span>
                      <span className="ws-item-card-note">
                        {board.columns.length} columns ֲ· edited{" "}
                        {when(board.updatedAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    className="ws-favorite"
                    aria-label={`${isFavorite({ kind: "board", id: board.id }) ? "Remove" : "Add"} ${board.name} ${isFavorite({ kind: "board", id: board.id }) ? "from" : "to"} favorites`}
                    aria-pressed={isFavorite({ kind: "board", id: board.id })}
                    disabled={!accountEmail}
                    onClick={() =>
                      toggleFavorite({ kind: "board", id: board.id })
                    }
                  >
                    <Star />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="ws-overview-section ws-overview-work">
          <header>
            <h2>Documents</h2>
            <span>{documents.length}</span>
            {canWrite && (
              <button
                className="ws-section-add"
                aria-label="Create document"
                title="Create document"
                onClick={() =>
                  setCreating({
                    kind: "document",
                    projectId: project.id,
                    folderId: null,
                  })
                }
              >
                <Plus />
              </button>
            )}
          </header>
          {recentDocuments.length === 0 ? (
            <p className="ws-overview-empty">No documents yet.</p>
          ) : (
            <div className="ws-cards">
              {recentDocuments.map((document) => (
                <div className="ws-shortcut-row" key={document.id}>
                  <button
                    className="ws-item-card"
                    onClick={() => onOpenDocument(document.id)}
                  >
                    <FileText strokeWidth={1.7} />
                    <span className="ws-item-card-main">
                      <span className="ws-item-card-title">
                        {document.title || "Untitled"}
                      </span>
                      <span className="ws-item-card-note">
                        edited {when(document.updatedAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    className="ws-favorite"
                    aria-label={`${isFavorite({ kind: "document", id: document.id }) ? "Remove" : "Add"} ${document.title || "Untitled"} ${isFavorite({ kind: "document", id: document.id }) ? "from" : "to"} favorites`}
                    aria-pressed={isFavorite({
                      kind: "document",
                      id: document.id,
                    })}
                    disabled={!accountEmail}
                    onClick={() =>
                      toggleFavorite({ kind: "document", id: document.id })
                    }
                  >
                    <Star />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="ws-overview-section ws-milestone-overview">
        <header>
          <h2>Roadmaps</h2>
          <span>{roadmaps.length}</span>
          {canWrite && (
            <button
              className="ws-section-add"
              aria-label="Create roadmap"
              title="Create roadmap"
              onClick={() =>
                setCreating({
                  kind: "roadmap",
                  projectId: project.id,
                  folderId: null,
                })
              }
            >
              <Plus />
            </button>
          )}
        </header>
        {recentRoadmaps.length === 0 ? (
          <p className="ws-overview-empty">No roadmaps yet.</p>
        ) : (
          <div className="ws-milestone-cards">
            {recentRoadmaps.map((roadmap) => (
              <button
                className="ws-milestone-card-link"
                key={roadmap.id}
                onClick={() => onOpenRoadmap(roadmap.id)}
              >
                <span className="ws-milestone-card-icon"><Route /></span>
                <span className="ws-milestone-card-main">
                  <strong>{roadmap.name || "Untitled"}</strong>
                  <small>
                    {milestones.filter((milestone) => milestone.roadmapId === roadmap.id).length} milestones
                  </small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="ws-overview-section ws-milestone-overview">
        <header>
          <h2>Brainstorms</h2>
          <span>{brainstorms.length}</span>
          {canWrite && (
            <button
              className="ws-section-add"
              aria-label="Create brainstorm"
              title="Create brainstorm"
              onClick={() =>
                setCreating({
                  kind: "brainstorm",
                  projectId: project.id,
                  folderId: null,
                })
              }
            >
              <Plus />
            </button>
          )}
        </header>
        {recentBrainstorms.length === 0 ? (
          <p className="ws-overview-empty">No brainstorms yet.</p>
        ) : (
          <div className="ws-milestone-cards">
            {recentBrainstorms.map((brainstorm) => (
              <button
                className="ws-milestone-card-link"
                key={brainstorm.id}
                onClick={() => onOpenBrainstorm(brainstorm.id)}
              >
                <span className="ws-milestone-card-icon">
                  <Lightbulb />
                </span>
                <span className="ws-milestone-card-main">
                  <strong>{brainstorm.name || "Untitled"}</strong>
                  <small>edited {when(brainstorm.updatedAt)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section
        className="ws-overview-section ws-overview-work ws-quick-access"
        aria-labelledby="quick-access-title"
      >
        <header>
          <h2 id="quick-access-title">Quick access</h2>
        </header>
        {favorites.length > 0 && (
          <div className="ws-quick-group">
            <h3>Favorites</h3>
            {shortcutList(favorites, "")}
          </div>
        )}
        {opened.length > 0 && (
          <div className="ws-quick-group">
            <h3>Recently opened</h3>
            {shortcutList(opened, "")}
          </div>
        )}
        {edited.length > 0 && (
          <div className="ws-quick-group">
            <h3>Recently edited</h3>
            {shortcutList(edited, "")}
          </div>
        )}
        {!favorites.length && !opened.length && !edited.length && (
          <p className="ws-overview-empty">
            Your favorite and recently opened work will appear here.
          </p>
        )}
      </section>

      <Dialog
        open={peopleOpen}
        title="People"
        description="Members and invitations for this project."
        width={680}
        onClose={() => setPeopleOpen(false)}
      >
        <MembersPanel project={project} />
      </Dialog>

      {canWrite && boards.length === 0 && documents.length === 0 ? (
        <div className="ws-overview-start">
          <p>
            An empty project. Start with a board for the work, or a document for
            the thinking.
          </p>
          <button
            className="btn btn-primary"
            onClick={() =>
              setCreating({
                kind: "board",
                projectId: project.id,
                folderId: null,
              })
            }
          >
            <Plus /> Create the first board
          </button>
        </div>
      ) : null}

      <CreateItemDialog request={creating} onClose={() => setCreating(null)} />
    </div>
  );
}
