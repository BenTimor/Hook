import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  BriefcaseBusiness,
  Bug,
  CalendarDays,
  CheckCircle2,
  Columns3,
  GraduationCap,
  Layers3,
  LayoutGrid,
  ListChecks,
  Megaphone,
  Plus,
  Rocket,
  Search,
  Sparkles,
  Star,
  Target,
  UserRound,
  Users,
} from "lucide-react";
import { Dialog } from "@hook/ui";

import {
  BOARD_TEMPLATES,
  TEMPLATE_CATEGORIES,
  instantiateTemplate,
  type BoardTemplate,
  type TemplateCategory,
  type TemplateColumn,
} from "../lib/boardTemplates";
import type { ColumnType } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { PersonAvatar } from "./AssigneesPicker";
import { statusColor } from "./TaskStatus";

function TemplateIcon({ name }: { name: string }) {
  switch (name) {
    case "check": return <CheckCircle2 />;
    case "calendar": return <CalendarDays />;
    case "sparkles": return <Sparkles />;
    case "graduation": return <GraduationCap />;
    case "book": return <BookOpen />;
    case "layers": return <Layers3 />;
    case "target": return <Target />;
    case "rocket": return <Rocket />;
    case "columns": return <Columns3 />;
    case "star": return <Star />;
    case "bug": return <Bug />;
    case "briefcase": return <BriefcaseBusiness />;
    case "users": return <Users />;
    case "user": return <UserRound />;
    case "megaphone": return <Megaphone />;
    case "plus": return <Plus />;
    default: return <ListChecks />;
  }
}

function CategoryIcon({ category }: { category: TemplateCategory | "All" }) {
  switch (category) {
    case "Personal": return <UserRound />;
    case "Study": return <BookOpen />;
    case "Product & Engineering": return <Rocket />;
    case "Business": return <BriefcaseBusiness />;
    case "Start from scratch": return <Plus />;
    default: return <LayoutGrid />;
  }
}

const TYPE_LABEL: Partial<Record<ColumnType, string>> = {
  status: "Status",
  select: "Select",
  multiselect: "Multi-select",
  person: "Person",
  checkbox: "Checkbox",
  date: "Date",
  datetime: "Date & time",
  daterange: "Timeline",
  number: "Number",
  progress: "Progress",
  text: "Text",
  longtext: "Long text",
  url: "URL",
  email: "Email",
  phone: "Phone",
};

const MUTED = <span className="ws-template-muted">—</span>;

function splitValues(value: string): string[] {
  return value.split(/,\s*/).map((entry) => entry.trim()).filter(Boolean);
}

function PreviewCell({ column, value }: { column: TemplateColumn; value: string | undefined }) {
  const text = value ?? "";
  if (!text) return MUTED;
  switch (column.type) {
    case "status": {
      const option = column.options?.find((entry) => entry.label === text);
      return (
        <span className="ws-template-pill" data-color={option?.color ?? statusColor(text)}>
          {text}
        </span>
      );
    }
    case "select":
      return <span className="ws-template-chip">{text}</span>;
    case "multiselect":
      return (
        <span className="ws-template-chips">
          {splitValues(text).map((entry) => (
            <span className="ws-template-chip" key={entry}>{entry}</span>
          ))}
        </span>
      );
    case "checkbox": {
      const done = /^(yes|true|done|✓)$/i.test(text);
      return <span className="ws-template-check" data-done={done}>{done ? "✓" : "☐"}</span>;
    }
    case "person":
      return (
        <span className="ws-template-person">
          <PersonAvatar small value={text} label={text} />
          <span>{text}</span>
        </span>
      );
    case "progress": {
      const progress = Math.max(0, Math.min(100, Number(text) || 0));
      return (
        <span className="ws-template-progress">
          <span><span style={{ width: `${progress}%` }} /></span>
          <small>{progress}%</small>
        </span>
      );
    }
    case "number":
      return <span className="ws-template-number">{text}</span>;
    case "date":
    case "datetime":
    case "daterange":
      return <span className="ws-template-date">{text}</span>;
    default:
      return <span className="ws-template-text">{text}</span>;
  }
}

export function BoardTemplateDialog({
  request,
  onClose,
}: {
  request: { projectId: string; folderId: string | null } | null;
  onClose: () => void;
}) {
  const createBoard = useWorkspaceStore((state) => state.createBoard);
  const openBoard = useWorkspaceStore((state) => state.openBoard);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TemplateCategory | "All">("All");
  const [selected, setSelected] = useState<BoardTemplate | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const projectId = request?.projectId ?? null;
  const folderId = request?.folderId ?? null;

  // Workspace polls for changes every few seconds, so the parent can re-render
  // while this dialog is open. Reset only when a different board request
  // actually opens - not when the request object is merely recreated.
  useEffect(() => {
    if (!projectId) return;
    setQuery("");
    setCategory("All");
    setSelected(null);
    setName("");
    setBusy(false);
    setError("");
  }, [projectId, folderId]);

  const templates = useMemo(() => {
    const term = query.trim().toLowerCase();
    return BOARD_TEMPLATES.filter(
      (template) =>
        (category === "All" || template.category === category) &&
        (!term ||
          `${template.name} ${template.description} ${template.category}`
            .toLowerCase()
            .includes(term)),
    );
  }, [query, category]);

  const choose = (template: BoardTemplate) => {
    setSelected(template);
    setName(template.id === "blank" ? "Untitled board" : template.name);
    setError("");
  };

  const create = async () => {
    if (!request || !selected) return;
    const title = name.trim() || selected.name;
    setBusy(true);
    setError("");
    const board = await createBoard(request.projectId, title, request.folderId, {
      description: selected.description,
      columns: instantiateTemplate(selected),
      view: selected.defaultView,
    });
    setBusy(false);
    if (!board) {
      const reason = useWorkspaceStore.getState().error;
      setError(
        reason
          ? `Could not create the board: ${reason}`
          : "Could not create the board. Try again.",
      );
      return;
    }
    onClose();
    void openBoard(board.id, request.projectId);
  };

  return (
    <Dialog
      open={request !== null}
      title="What do you want to organize?"
      description="Start with a template you can reshape later. Every template is the same flexible board underneath."
      width={1040}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!selected || busy} onClick={() => void create()}>
            {busy ? "Creating…" : selected ? `Use ${selected.name}` : "Choose a template"}
          </button>
        </>
      }
    >
      <div className="ws-template-picker">
        <div className="ws-template-browse">
          <label className="ws-template-search">
            <Search aria-hidden="true" />
            <input
              autoFocus
              value={query}
              placeholder="Search templates"
              aria-label="Search templates"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="ws-template-categories" role="tablist" aria-label="Template categories">
            {(["All", ...TEMPLATE_CATEGORIES] as Array<TemplateCategory | "All">).map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                data-active={category === entry}
                onClick={() => setCategory(entry)}
              >
                <CategoryIcon category={entry} />
                <span>{entry}</span>
              </button>
            ))}
          </div>
          <div className="ws-template-grid">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="ws-template-card"
                data-category={template.category}
                data-active={selected?.id === template.id}
                onClick={() => choose(template)}
              >
                <span className="ws-template-card-top">
                  <span className="ws-template-icon"><TemplateIcon name={template.icon} /></span>
                  <span className="ws-template-category">{template.category}</span>
                </span>
                <span className="ws-template-card-title">{template.name}</span>
                <span className="ws-template-card-copy">{template.description}</span>
                <span className="ws-template-card-meta">
                  {template.columns.slice(0, 3).map((column) => column.name).join(" · ") || "Title only"}
                  {template.columns.length > 3 ? ` +${template.columns.length - 3}` : ""}
                </span>
              </button>
            ))}
            {templates.length === 0 ? (
              <p className="ws-template-empty">No templates match that search.</p>
            ) : null}
          </div>
        </div>

        <aside
          className="ws-template-preview"
          data-category={selected?.category}
          aria-live="polite"
        >
          {selected ? (
            <>
              <div className="ws-template-preview-head">
                <span className="ws-template-icon"><TemplateIcon name={selected.icon} /></span>
                <div>
                  <span className="ws-template-category">{selected.category}</span>
                  <h3>{selected.name}</h3>
                  <p>{selected.description}</p>
                </div>
              </div>
              <label className="dlg-field">
                <span>Board name</span>
                <input
                  className="text-input"
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && name.trim()) void create();
                  }}
                />
              </label>
              <div className="ws-template-props">
                <span className="ws-template-props-label">Properties</span>
                <div className="ws-template-props-list">
                  <span className="ws-template-prop">Task</span>
                  {selected.columns.map((column) => (
                    <span className="ws-template-prop" key={column.name}>
                      {column.name}
                      <small>{TYPE_LABEL[column.type] ?? column.type}</small>
                    </span>
                  ))}
                </div>
              </div>
              <div className="ws-template-rows-wrap">
                <span className="ws-template-props-label">Preview</span>
                <div className="ws-template-board">
                  <div className="ws-template-board-head">
                    <span className="ws-template-window-dots" aria-hidden="true">
                      <i /><i /><i />
                    </span>
                    <strong>{name.trim() || selected.name}</strong>
                    <span className="ws-template-window-tabs">
                      <b>Table</b>
                      <span>Board</span>
                    </span>
                  </div>
                  <div
                    className="ws-template-board-row ws-template-board-head-row"
                    style={{
                      gridTemplateColumns: `minmax(110px, 1.5fr) repeat(${Math.min(selected.columns.length, 4)}, minmax(72px, 1fr))`,
                    }}
                  >
                    <span>Task</span>
                    {selected.columns.slice(0, 4).map((column) => (
                      <span key={column.name}>{column.name}</span>
                    ))}
                  </div>
                  {selected.sampleRows.map((row, index) => (
                    <div
                      className="ws-template-board-row"
                      key={index}
                      style={{
                        gridTemplateColumns: `minmax(110px, 1.5fr) repeat(${Math.min(selected.columns.length, 4)}, minmax(72px, 1fr))`,
                      }}
                    >
                      <span className="ws-template-board-title">{row.Task ?? "New item"}</span>
                      {selected.columns.slice(0, 4).map((column) => (
                        <span className="ws-template-board-cell" key={column.name}>
                          <PreviewCell column={column} value={row[column.name]} />
                        </span>
                      ))}
                    </div>
                  ))}
                  <div className="ws-template-board-add">
                    <Plus aria-hidden="true" /> Add task
                  </div>
                </div>
              </div>
              <p className="ws-template-hint">
                You can add, remove or rename any property after creating the board.
              </p>
            </>
          ) : (
            <div className="ws-template-preview-empty">
              <ListChecks aria-hidden="true" />
              <p>Pick a template to see what it includes.</p>
            </div>
          )}
          {error ? <p className="ws-template-error" role="alert">{error}</p> : null}
        </aside>
      </div>
    </Dialog>
  );
}
