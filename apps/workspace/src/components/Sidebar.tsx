import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronRight,
  FilePlus2,
  Flag,
  LogOut,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  House,
  KanbanSquare,
  Mail,
  MoreHorizontal,
  Plus,
  Settings2,
  Users,
} from "lucide-react";

import { Dialog, HookMark, TextFieldDialog } from "@hook/ui";

import type { Board, DocumentMeta, Folder, Milestone, Project, Role } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { PersonAvatar } from "./AssigneesPicker";
import { CreateItemDialog, type CreateRequest } from "./CreateItem";
import { PopupMenu, type MenuEntry } from "./PopupMenu";

const CAN_WRITE: Role[] = ["owner", "manager", "editor"];

type Target =
  | { kind: "project"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "board"; id: string }
  | { kind: "document"; id: string }
  | { kind: "milestone"; id: string };

type Menu = { x: number; y: number; target: Target };
type Rename = { target: Target; projectId: string; value: string };
type Remove = { target: Target; projectId: string };

const PREF_KEY = "hook.workspace.tree";

function readExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * The rail: every project with its folders, boards and documents in one tree.
 *
 * There is no second column anywhere. A project behaves like a special folder
 * — it is the account's unit of sharing, so it is the root — and everything
 * else lives under it. Right click anywhere in the tree for what that thing
 * can do; the plus on a project or folder creates something inside it.
 */
export function Sidebar({
  email,
  name,
  homeActive,
  invitesActive,
  onHome,
  onNewProject,
  onOpenInvites,
  onSettings,
  onLogout,
}: {
  email: string | null;
  name: string | null;
  homeActive: boolean;
  invitesActive: boolean;
  onHome: () => void;
  onNewProject: () => void;
  onOpenInvites: () => void;
  onSettings: () => void;
  onLogout: () => void;
}) {
  const projects = useWorkspaceStore((state) => state.projects);
  const invites = useWorkspaceStore((state) => state.invites);
  const pendingInviteCount = invites.filter((invite) => invite.status === "pending").length;
  const boards = useWorkspaceStore((state) => state.boards);
  const documents = useWorkspaceStore((state) => state.documents);
  const milestones = useWorkspaceStore((state) => state.milestones);
  const folders = useWorkspaceStore((state) => state.folders);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const activeBoardId = useWorkspaceStore((state) => state.activeBoardId);
  const activeDocumentId = useWorkspaceStore((state) => state.activeDocumentId);
  const activeMilestoneId = useWorkspaceStore((state) => state.activeMilestoneId);
  const displayName = name?.trim() || email?.split("@")[0] || "Account";

  const openProject = useWorkspaceStore((state) => state.openProject);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const openDocument = useWorkspaceStore((state) => state.openDocument);
  const openMilestone = useWorkspaceStore((state) => state.openMilestone);
  const loadProjectContents = useWorkspaceStore((state) => state.loadProjectContents);
  const renameProject = useWorkspaceStore((state) => state.renameProject);
  const renameFolder = useWorkspaceStore((state) => state.renameFolder);
  const renameBoard = useWorkspaceStore((state) => state.renameBoard);
  const renameDocument = useWorkspaceStore((state) => state.renameDocument);
  const renameMilestone = useWorkspaceStore((state) => state.renameMilestone);
  const moveBoard = useWorkspaceStore((state) => state.moveBoard);
  const moveDocument = useWorkspaceStore((state) => state.moveDocument);
  const moveMilestone = useWorkspaceStore((state) => state.moveMilestone);
  const moveFolder = useWorkspaceStore((state) => state.moveFolder);
  const deleteProject = useWorkspaceStore((state) => state.deleteProject);
  const deleteFolder = useWorkspaceStore((state) => state.deleteFolder);
  const deleteBoard = useWorkspaceStore((state) => state.deleteBoard);
  const deleteDocument = useWorkspaceStore((state) => state.deleteDocument);
  const deleteMilestone = useWorkspaceStore((state) => state.deleteMilestone);

  const [expanded, setExpanded] = useState<Record<string, boolean>>(readExpanded);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [creating, setCreating] = useState<CreateRequest | null>(null);
  const [renaming, setRenaming] = useState<Rename | null>(null);
  const [removing, setRemoving] = useState<Remove | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(expanded));
    } catch {
      // A full quota must not break the rail.
    }
  }, [expanded]);

  // The project you are looking at is always open, and its contents are only
  // fetched when it is (or when it is expanded for the first time).
  useEffect(() => {
    if (!activeProjectId) return;
    setExpanded((current) => (current[activeProjectId] ? current : { ...current, [activeProjectId]: true }));
    if (!boards[activeProjectId]) void loadProjectContents(activeProjectId);
  }, [activeProjectId, boards, loadProjectContents]);

  const projectOf = (target: Target): Project | null =>
    projects.find((project) =>
      target.kind === "project"
        ? project.id === target.id
        : target.kind === "folder"
          ? (folders[project.id] ?? []).some((folder) => folder.id === target.id)
          : target.kind === "board"
            ? (boards[project.id] ?? []).some((board) => board.id === target.id)
            : target.kind === "document"
              ? (documents[project.id] ?? []).some((document) => document.id === target.id)
              : (milestones[project.id] ?? []).some((milestone) => milestone.id === target.id),
    ) ?? null;

  const findFolder = (id: string): { folder: Folder; projectId: string } | null => {
    for (const [projectId, list] of Object.entries(folders)) {
      const folder = list.find((candidate) => candidate.id === id);
      if (folder) return { folder, projectId };
    }
    return null;
  };
  const findBoard = (id: string): { board: Board; projectId: string } | null => {
    for (const [projectId, list] of Object.entries(boards)) {
      const board = list.find((candidate) => candidate.id === id);
      if (board) return { board, projectId };
    }
    return null;
  };
  const findDocument = (id: string): { document: DocumentMeta; projectId: string } | null => {
    for (const [projectId, list] of Object.entries(documents)) {
      const document = list.find((candidate) => candidate.id === id);
      if (document) return { document, projectId };
    }
    return null;
  };
  const findMilestone = (id: string): { milestone: Milestone; projectId: string } | null => {
    for (const [projectId, list] of Object.entries(milestones)) {
      const milestone = list.find((candidate) => candidate.id === id);
      if (milestone) return { milestone, projectId };
    }
    return null;
  };

  const toggle = (id: string, projectId: string, loaded: boolean) => {
    const next = !expanded[id];
    setExpanded((current) => ({ ...current, [id]: next }));
    if (next && !loaded) void loadProjectContents(projectId);
  };

  const startCreate = (kind: CreateRequest["kind"], projectId: string, folderId: string | null) => {
    setExpanded((current) => ({ ...current, [folderId ?? projectId]: true }));
    setCreating({ kind, projectId, folderId });
  };

  /**
   * Where a folder really sits.
   *
   * A row can point at a folder that no longer exists — another device removed
   * it, or this one did before the server learned to move its contents. Such a
   * row belongs at the top level: the tree must never hide work because of a
   * tidy-up, so an unknown parent is treated as none.
   */
  const parentOf = (projectId: string, folderId: string | null): string | null => {
    if (!folderId) return null;
    const known = (folders[projectId] ?? []).some((folder) => folder.id === folderId);
    return known ? folderId : null;
  };

  /** What a folder delete would take with it, for the dialog to say out loud. */
  const countInside = (projectId: string, folderId: string) => {
    const list = folders[projectId] ?? [];
    const inside = new Set([folderId]);
    for (const folder of inside) {
      for (const candidate of list) {
        if (candidate.parentId === folder) inside.add(candidate.id);
      }
    }
    return {
      boards: (boards[projectId] ?? []).filter(
        (board) => board.folderId && inside.has(board.folderId),
      ).length,
      documents: (documents[projectId] ?? []).filter(
        (document) => document.folderId && inside.has(document.folderId),
      ).length,
      milestones: (milestones[projectId] ?? []).filter(
        (milestone) => milestone.folderId && inside.has(milestone.folderId),
      ).length,
    };
  };

  /** Every folder of a project, flattened in tree order for a "Move to" list. */
  const folderOptions = (projectId: string): Array<{ folder: Folder; depth: number }> => {
    const list = folders[projectId] ?? [];
    const out: Array<{ folder: Folder; depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
      for (const folder of list.filter(
        (candidate) => parentOf(projectId, candidate.parentId) === parent,
      )) {
        out.push({ folder, depth });
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  };

  const moveEntries = (target: Target, projectId: string, kind: "board" | "document" | "milestone" | "folder"): MenuEntry[] => {
    const options = folderOptions(projectId);
    const inside = new Set<string>([target.id]);
    if (kind === "folder") {
      // A folder cannot move into itself or below itself.
      const list = folders[projectId] ?? [];
      const walk = (parent: string) => {
        for (const folder of list) {
          if (folder.parentId !== parent || inside.has(folder.id)) continue;
          inside.add(folder.id);
          walk(folder.id);
        }
      };
      walk(target.id);
    }
    const current =
      kind === "board"
        ? findBoard(target.id)?.board.folderId ?? null
        : kind === "document"
          ? findDocument(target.id)?.document.folderId ?? null
          : kind === "milestone"
            ? findMilestone(target.id)?.milestone.folderId ?? null
            : findFolder(target.id)?.folder.parentId ?? null;
    const move = (folderId: string | null) => {
      if (kind === "board") void moveBoard(target.id, folderId);
      if (kind === "document") void moveDocument(target.id, folderId);
      if (kind === "milestone") void moveMilestone(target.id, folderId);
      if (kind === "folder") void moveFolder(projectId, target.id, folderId);
    };
    return [
      { kind: "heading", label: "Move to" },
      {
        kind: "action",
        label: "Top level",
        checked: current === null,
        onSelect: () => move(null),
      },
      ...options
        .filter(({ folder }) => !inside.has(folder.id))
        .map(({ folder, depth }) => ({
          kind: "action" as const,
          label: folder.name,
          indent: depth,
          checked: current === folder.id,
          onSelect: () => move(folder.id),
        })),
    ];
  };

  const entriesFor = (target: Target): MenuEntry[] => {
    const project = projectOf(target);
    if (!project) return [];
    const canWrite = CAN_WRITE.includes(project.role);
    const isOwner = project.role === "owner";

    if (target.kind === "project") {
      return [
        { kind: "action", label: "Open", onSelect: () => void openProject(project.id) },
        ...(canWrite
          ? [
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "New folder…",
                icon: <FolderPlus />,
                onSelect: () => startCreate("folder", project.id, null),
              },
              {
                kind: "action" as const,
                label: "New board…",
                icon: <KanbanSquare />,
                onSelect: () => startCreate("board", project.id, null),
              },
              {
                kind: "action" as const,
                label: "New document…",
                icon: <FilePlus2 />,
                onSelect: () => startCreate("document", project.id, null),
              },
              {
                kind: "action" as const,
                label: "New milestone…",
                icon: <Flag />,
                onSelect: () => startCreate("milestone", project.id, null),
              },
            ]
          : []),
        { kind: "separator" },
        { kind: "action", label: "People", icon: <Users />, onSelect: () => void openProject(project.id) },
        ...(canWrite
          ? [
              {
                kind: "action" as const,
                label: "Rename project…",
                onSelect: () => setRenaming({ target, projectId: project.id, value: project.name }),
              },
            ]
          : []),
        ...(isOwner
          ? [
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Delete project…",
                danger: true,
                onSelect: () => setRemoving({ target, projectId: project.id }),
              },
            ]
          : []),
      ];
    }

    if (target.kind === "folder") {
      const folder = findFolder(target.id);
      if (!folder) return [];
      return [
        ...(canWrite
          ? [
              {
                kind: "action" as const,
                label: "New folder inside…",
                icon: <FolderPlus />,
                onSelect: () => startCreate("folder", project.id, folder.folder.id),
              },
              {
                kind: "action" as const,
                label: "New board…",
                icon: <KanbanSquare />,
                onSelect: () => startCreate("board", project.id, folder.folder.id),
              },
              {
                kind: "action" as const,
                label: "New document…",
                icon: <FilePlus2 />,
                onSelect: () => startCreate("document", project.id, folder.folder.id),
              },
              {
                kind: "action" as const,
                label: "New milestone…",
                icon: <Flag />,
                onSelect: () => startCreate("milestone", project.id, folder.folder.id),
              },
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Rename folder…",
                onSelect: () =>
                  setRenaming({ target, projectId: project.id, value: folder.folder.name }),
              },
            ]
          : []),
        ...(canWrite
          ? [
              { kind: "separator" as const },
              ...moveEntries(target, project.id, "folder"),
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Delete folder…",
                danger: true,
                onSelect: () => setRemoving({ target, projectId: project.id }),
              },
            ]
          : []),
      ];
    }

    if (target.kind === "board") {
      const board = findBoard(target.id)?.board;
      if (!board) return [];
      return [
        { kind: "action", label: "Open", onSelect: () => void openBoard(board.id, project.id) },
        ...(canWrite
          ? [
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Rename board…",
                onSelect: () => setRenaming({ target, projectId: project.id, value: board.name }),
              },
              { kind: "separator" as const },
              ...moveEntries(target, project.id, "board"),
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Delete board…",
                danger: true,
                onSelect: () => setRemoving({ target, projectId: project.id }),
              },
            ]
          : []),
      ];
    }

    if (target.kind === "milestone") {
      const milestone = findMilestone(target.id)?.milestone;
      if (!milestone) return [];
      return [
        { kind: "action", label: "Open", onSelect: () => void openMilestone(milestone.id, project.id) },
        ...(canWrite
          ? [
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Rename milestone…",
                onSelect: () =>
                  setRenaming({ target, projectId: project.id, value: milestone.title || "Untitled" }),
              },
              { kind: "separator" as const },
              ...moveEntries(target, project.id, "milestone"),
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Delete milestone…",
                danger: true,
                onSelect: () => setRemoving({ target, projectId: project.id }),
              },
            ]
          : []),
      ];
    }

    const document = findDocument(target.id)?.document;
    if (!document) return [];
    return [
      { kind: "action", label: "Open", onSelect: () => void openDocument(document.id, project.id) },
      ...(canWrite
        ? [
            { kind: "separator" as const },
            {
              kind: "action" as const,
              label: "Rename document…",
              onSelect: () =>
                setRenaming({
                  target,
                  projectId: project.id,
                  value: document.title || "Untitled",
                }),
            },
            { kind: "separator" as const },
            ...moveEntries(target, project.id, "document"),
            { kind: "separator" as const },
            {
              kind: "action" as const,
              label: "Delete document…",
              danger: true,
              onSelect: () => setRemoving({ target, projectId: project.id }),
            },
          ]
        : []),
    ];
  };

  const row = (
    options: {
      kind: "project" | "folder" | "board" | "document" | "milestone";
      id: string;
      label: string;
      depth: number;
      icon: ReactNode;
      active: boolean;
      open?: boolean;
      hasChildren?: boolean;
      projectId: string;
      loaded: boolean;
      onOpen: () => void;
    },
  ) => {
    const openMenu = (x: number, y: number) =>
      setMenu({ x, y, target: { kind: options.kind, id: options.id } });
    const project = projects.find((candidate) => candidate.id === options.projectId);
    const canWrite = project ? CAN_WRITE.includes(project.role) : false;
    return (
      <div
        key={options.kind + options.id}
        className="ws-row"
        data-kind={options.kind}
        data-active={options.active}
        style={{ paddingLeft: 4 + options.depth * 13 }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY);
        }}
      >
        {options.hasChildren ? (
          <button
            className="ws-row-toggle"
            data-open={options.open ? "true" : undefined}
            aria-label={options.open ? "Collapse" : "Expand"}
            onClick={() =>
              toggle(options.id, options.projectId, options.loaded)
            }
          >
            <ChevronRight strokeWidth={2} />
          </button>
        ) : (
          <span className="ws-row-toggle" aria-hidden="true" />
        )}
        <span className="ws-row-icon">{options.icon}</span>
        <button className="ws-row-label" title={options.label} onClick={options.onOpen}>
          {options.label}
        </button>
        {canWrite && (options.kind === "project" || options.kind === "folder") ? (
          <button
            className="ws-row-action"
            title="Add inside"
            aria-label="Add inside"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                x: rect.right - 4,
                y: rect.bottom + 4,
                target: { kind: options.kind, id: options.id },
              });
            }}
          >
            <Plus strokeWidth={2} />
          </button>
        ) : null}
        <button
          className="ws-row-action ws-row-more"
          title="Options"
          aria-label="Options"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right - 172, rect.bottom + 4);
          }}
        >
          <MoreHorizontal strokeWidth={2} />
        </button>
      </div>
    );
  };

  const leafRows = (
    project: Project,
    parentId: string | null,
    depth: number,
  ): ReactNode[] => {
    const items: ReactNode[] = [];
    for (const board of (boards[project.id] ?? []).filter(
      (candidate) => parentOf(project.id, candidate.folderId) === parentId,
    )) {
      items.push(
        row({
          kind: "board",
          id: board.id,
          label: board.name,
          depth,
          projectId: project.id,
          active: board.id === activeBoardId,
          loaded: true,
          icon: <KanbanSquare strokeWidth={1.8} />,
          onOpen: () => void openBoard(board.id, project.id),
        }),
      );
    }
    for (const document of (documents[project.id] ?? []).filter(
      (candidate) => parentOf(project.id, candidate.folderId) === parentId,
    )) {
      items.push(
        row({
          kind: "document",
          id: document.id,
          label: document.title || "Untitled",
          depth,
          projectId: project.id,
          active: document.id === activeDocumentId,
          loaded: true,
          icon: <FileText strokeWidth={1.8} />,
          onOpen: () => void openDocument(document.id, project.id),
        }),
      );
    }
    for (const milestone of (milestones[project.id] ?? []).filter(
      (candidate) => parentOf(project.id, candidate.folderId) === parentId,
    )) {
      items.push(
        row({
          kind: "milestone",
          id: milestone.id,
          label: milestone.title || "Untitled",
          depth,
          projectId: project.id,
          active: milestone.id === activeMilestoneId,
          loaded: true,
          icon: <Flag strokeWidth={1.8} />,
          onOpen: () => void openMilestone(milestone.id, project.id),
        }),
      );
    }
    return items;
  };

  const folderRows = (project: Project, parentId: string | null, depth: number): ReactNode[] =>
    (folders[project.id] ?? [])
      .filter((folder) => parentOf(project.id, folder.parentId) === parentId)
      .flatMap((folder) => {
        const loaded = boards[project.id] !== undefined;
        const open = expanded[folder.id] ?? false;
        const children = [
          ...folderRows(project, folder.id, depth + 1),
          ...leafRows(project, folder.id, depth + 1),
        ];
        return [
          row({
            kind: "folder",
            id: folder.id,
            label: folder.name,
            depth,
            projectId: project.id,
            active: false,
            open,
            hasChildren: children.length > 0,
            loaded,
            icon: <FolderIcon strokeWidth={1.8} />,
            onOpen: () => toggle(folder.id, project.id, loaded),
          }),
          ...(open ? children : []),
        ];
      });

  const tree = projects.map((project) => {
    const loaded = boards[project.id] !== undefined;
        const open = expanded[project.id] ?? false;
        const children = open
          ? [
              ...folderRows(project, null, 1),
              ...leafRows(project, null, 1),
            ]
          : [];
        return (
          <div className="ws-tree-group" key={project.id}>
            {row({
              kind: "project",
              id: project.id,
              label: project.name,
              depth: 0,
              projectId: project.id,
              active: project.id === activeProjectId && !activeBoardId && !activeDocumentId && !activeMilestoneId,
              open,
              hasChildren: true,
              loaded,
              icon: (
                <span className="ws-project-badge" aria-hidden="true">
                  {project.name.trim().charAt(0).toUpperCase() || "H"}
                </span>
              ),
              onOpen: () => void openProject(project.id),
            })}
            {open ? (
              children.length > 0 ? (
                children
              ) : (
                <p className="ws-tree-hint">
                  {loaded ? "Empty. Right-click to add something." : "Opening…"}
                </p>
              )
            ) : null}
          </div>
        );
      });

  const removeCopy = (() => {
    if (!removing) return null;
    if (removing.target.kind === "project") {
      return {
        title: "Delete this project?",
        description:
          "Its boards, tasks and documents go with it, for everyone in it. This cannot be undone.",
        confirm: "Delete project",
      };
    }
    if (removing.target.kind === "folder") {
      const inner = countInside(removing.projectId, removing.target.id);
      return {
        title: "Delete this folder and everything in it?",
        description: `The boards${inner.boards > 0 ? ` (${inner.boards})` : ""}${
          inner.boards > 0 ? " with their tasks" : ""
        }, its documents${inner.documents > 0 ? ` (${inner.documents})` : ""}, its milestones${
          inner.milestones > 0 ? ` (${inner.milestones})` : ""
        } and any folders inside it are deleted for everyone in the project. This cannot be undone.`,
        confirm: "Delete everything",
      };
    }
    if (removing.target.kind === "board") {
      return {
        title: "Delete this board?",
        description: "Its tasks go with it, for everyone in the project. This cannot be undone.",
        confirm: "Delete board",
      };
    }
    if (removing.target.kind === "milestone") {
      return {
        title: "Delete this milestone?",
        description: "Its date, status and description go with it, for everyone in the project. This cannot be undone.",
        confirm: "Delete milestone",
      };
    }
    return {
      title: "Delete this document?",
      description:
        "The text goes with it, for everyone in the project. This cannot be undone.",
      confirm: "Delete document",
    };
  })();

  return (
    <>
      <aside className="ws-rail" data-tauri-drag-region>
        <button className="ws-wordmark" onClick={onHome} aria-label="Workspace home">
          <HookMark />
          <span>Workspace</span>
        </button>

        <nav className="ws-main-nav" aria-label="Workspace navigation">
          <button
            className="ws-nav-row"
            data-active={homeActive}
            aria-current={homeActive ? "page" : undefined}
            onClick={onHome}
            title="Home"
          >
            <House />
            <span className="ws-nav-label">Home</span>
          </button>
          <button
            className="ws-nav-row ws-nav-invites"
            data-active={invitesActive}
            data-pending={pendingInviteCount > 0}
            aria-current={invitesActive ? "page" : undefined}
            aria-label={`Invites${pendingInviteCount ? `, ${pendingInviteCount} pending` : ""}`}
            onClick={onOpenInvites}
            title="Invites"
          >
            <Mail />
            <span className="ws-nav-label">Invites</span>
            {pendingInviteCount > 0 && <span className="ws-badge">{pendingInviteCount}</span>}
          </button>
        </nav>

        <button className="ws-new" onClick={onNewProject} title="New project" aria-label="New project">
          <Plus strokeWidth={1.9} />
          <span>New project</span>
        </button>

        <div className="ws-tree" role="tree" aria-label="Projects">
          {projects.length === 0 ? (
            <p className="ws-tree-hint">No projects yet. Make the first one.</p>
          ) : (
            tree
          )}
        </div>

        <div className="ws-rail-foot">
          <button
            className="ws-nav-row"
            onClick={onSettings}
            title="Settings"
            aria-label="Settings"
          >
            <Settings2 />
            <span className="ws-nav-label">Settings</span>
          </button>
          <button
            className="ws-nav-row ws-account-row"
            onClick={onLogout}
            title={`Sign out ${displayName}${email ? ` (${email})` : ""}`}
            aria-label={`Sign out ${displayName}`}
          >
            <PersonAvatar small value={email ?? displayName} label={displayName} />
            <span className="ws-account-name">{displayName}</span>
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </aside>

      {menu ? (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          entries={entriesFor(menu.target)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <CreateItemDialog request={creating} onClose={() => setCreating(null)} />

      <TextFieldDialog
        open={renaming !== null}
        title={
          renaming?.target.kind === "project"
            ? "Rename project"
            : renaming?.target.kind === "folder"
              ? "Rename folder"
              : renaming?.target.kind === "board"
                ? "Rename board"
                : renaming?.target.kind === "milestone"
                  ? "Rename milestone"
                  : "Rename document"
        }
        label={
          renaming?.target.kind === "document" || renaming?.target.kind === "milestone"
            ? "Title"
            : "Name"
        }
        value={renaming?.value ?? ""}
        onChange={(value) => setRenaming((current) => (current ? { ...current, value } : current))}
        confirm="Save"
        onClose={() => setRenaming(null)}
        onConfirm={() => {
          const pending = renaming;
          const value = pending?.value.trim();
          if (!pending || !value) return;
          setRenaming(null);
          if (pending.target.kind === "project") void renameProject(pending.projectId, value);
          if (pending.target.kind === "folder")
            void renameFolder(pending.projectId, pending.target.id, value);
          if (pending.target.kind === "board") void renameBoard(pending.target.id, value);
          if (pending.target.kind === "document") void renameDocument(pending.target.id, value);
          if (pending.target.kind === "milestone") void renameMilestone(pending.target.id, value);
        }}
      />

      <Dialog
        open={removing !== null}
        title={removeCopy?.title ?? ""}
        description={removeCopy?.description ?? ""}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRemoving(null)}>
              Keep it
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                const pending = removing;
                setRemoving(null);
                if (!pending) return;
                if (pending.target.kind === "project") void deleteProject(pending.projectId);
                if (pending.target.kind === "folder")
                  void deleteFolder(pending.projectId, pending.target.id);
                if (pending.target.kind === "board") void deleteBoard(pending.target.id);
                if (pending.target.kind === "document") void deleteDocument(pending.target.id);
                if (pending.target.kind === "milestone") void deleteMilestone(pending.target.id);
              }}
            >
              {removeCopy?.confirm ?? "Delete"}
            </button>
          </>
        }
      />
    </>
  );
}
