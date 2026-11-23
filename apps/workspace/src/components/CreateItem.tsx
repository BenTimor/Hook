import { useEffect, useState } from "react";

import { TextFieldDialog } from "@hook/ui";

import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { BoardTemplateDialog } from "./BoardTemplateDialog";

export type CreateRequest = {
  kind: "folder" | "board" | "document" | "roadmap";
  projectId: string;
  folderId: string | null;
};

const COPY = {
  folder: {
    title: "New folder",
    description:
      "Folders organize boards and documents inside a project. Everyone in it sees the same tree.",
    placeholder: "Design",
    confirm: "Create folder",
  },
  board: {
    title: "New board",
    description: "Boards hold tasks. A new board starts with Backlog, To do, In progress and Done.",
    placeholder: "Sprint 1",
    confirm: "Create board",
  },
  document: {
    title: "New document",
    description:
      "A Markdown document. The text is the document, so an agent can read and write it directly.",
    placeholder: "Roadmap",
    confirm: "Create document",
  },
  roadmap: {
    title: "New roadmap",
    description:
      "A roadmap is a horizontal timeline of milestones. Create the roadmap now; add its milestone circles inside.",
    placeholder: "Release roadmap",
    confirm: "Create roadmap",
  },
} as const;

/**
 * One dialog for the four things a project holds.
 *
 * The tree, the overview and the empty states all create the same way, so the
 * flow (and its copy) lives in one place, and a new board, document or roadmap
 * is open the moment it exists.
 */
export function CreateItemDialog({
  request,
  onClose,
}: {
  request: CreateRequest | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const createDocument = useWorkspaceStore((state) => state.createDocument);
  const createRoadmap = useWorkspaceStore((state) => state.createRoadmap);
  const createFolder = useWorkspaceStore((state) => state.createFolder);
  const openDocument = useWorkspaceStore((state) => state.openDocument);
  const openRoadmap = useWorkspaceStore((state) => state.openRoadmap);

  useEffect(() => {
    if (request) setName("");
  }, [request]);

  if (request?.kind === "board") {
    return <BoardTemplateDialog request={request} onClose={onClose} />;
  }

  const copy = COPY[request?.kind ?? "document"];

  return (
    <TextFieldDialog
      open={request !== null}
      title={copy.title}
      description={copy.description}
      label={request?.kind === "document" ? "Title" : "Name"}
      placeholder={copy.placeholder}
      value={name}
      onChange={setName}
      confirm={copy.confirm}
      onClose={onClose}
      onConfirm={() => {
        const value = name.trim();
        if (!value || !request) return;
        onClose();
        if (request.kind === "folder") {
          void createFolder(request.projectId, value, request.folderId);
          return;
        }
        if (request.kind === "roadmap") {
          void createRoadmap(request.projectId, value, request.folderId).then((roadmap) => {
            if (roadmap) void openRoadmap(roadmap.id, request.projectId);
          });
          return;
        }
        void createDocument(request.projectId, value, request.folderId).then((document) => {
          if (document) void openDocument(document.id, request.projectId);
        });
      }}
    />
  );
}
