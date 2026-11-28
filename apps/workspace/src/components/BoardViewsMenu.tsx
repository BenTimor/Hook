import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Layers, Pencil, Plus, Star, Trash2 } from "lucide-react";

import type { Board } from "../lib/types";

/**
 * The board's saved views, where they are chosen and where they are made.
 *
 * A view is a preset of what is shown, not a separate place: switching one is
 * a filter change, never a navigation. The star is the board's default - the
 * view a fresh window opens on - and it is stored on the board so every device
 * opens the board the same way.
 */
export function BoardViewsMenu({
  board,
  activeId,
  canEdit,
  onSelect,
  onSaveAs,
  onRename,
  onSetDefault,
  onDelete,
}: {
  board: Board;
  activeId: string | null;
  canEdit: boolean;
  onSelect: (id: string | null) => void;
  onSaveAs: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onSetDefault: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const views = board.views ?? [];
  const active = views.find((view) => view.id === activeId) ?? null;
  const activeName = active?.name ?? "All tasks";

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (creating || renaming || confirmDelete) {
        setCreating(false);
        setRenaming(null);
        setConfirmDelete(null);
        return;
      }
      setOpen(false);
      trigger.current?.focus();
    };
    const reposition = (event: Event) => {
      if (event.type === "scroll" && event.target instanceof Node && menu.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, creating, renaming, confirmDelete]);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const top = window.innerHeight - rect.bottom < 360 && rect.top > 380
      ? rect.top - 370
      : Math.min(rect.bottom + 8, window.innerHeight - 360);
    setPosition({ top: Math.max(12, top), left });
    setCreating(false);
    setRenaming(null);
    setConfirmDelete(null);
    setOpen(true);
  };

  const choose = (id: string | null) => {
    onSelect(id);
    setOpen(false);
    trigger.current?.focus();
  };

  const commitRename = (id: string) => {
    const name = renameDraft.trim();
    if (name) onRename(id, name);
    setRenaming(null);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost ws-view-trigger"
        data-active={Boolean(active)}
        aria-label="Board views"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <Layers aria-hidden="true" />
        <span className="ws-view-trigger-name">{activeName}</span>
        <ChevronDown className="ws-view-chevron" aria-hidden="true" />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menu}
              className="ws-view-menu"
              style={{ top: position.top, left: position.left }}
              role="dialog"
              aria-label="Board views"
            >
              <div className="ws-view-menu-head">
                <span>Views</span>
                <span className="ws-view-menu-hint">
                  {views.length === 0 ? "Filter and hide columns, then save it" : `${views.length} saved`}
                </span>
              </div>

              <div className="ws-view-list">
                <button
                  type="button"
                  className="ws-view-row"
                  data-active={!activeId}
                  onClick={() => choose(null)}
                >
                  <span className="ws-view-row-name">All tasks</span>
                  <span className="ws-view-row-meta">Everything</span>
                  <span className="ws-view-row-check" aria-hidden="true">
                    {!activeId ? <Check /> : null}
                  </span>
                </button>
                {views.map((view) => (
                  <div className="ws-view-row-wrap" key={view.id}>
                    {renaming === view.id ? (
                      <form
                        className="ws-view-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          commitRename(view.id);
                        }}
                      >
                        <input
                          autoFocus
                          value={renameDraft}
                          maxLength={40}
                          aria-label="View name"
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setRenaming(null);
                          }}
                        />
                        <button type="submit" className="btn btn-ghost" disabled={!renameDraft.trim()}>
                          Save
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="ws-view-row"
                          data-active={view.id === activeId}
                          onClick={() => choose(view.id)}
                        >
                          <span className="ws-view-row-name">{view.name}</span>
                          <span className="ws-view-row-meta">
                            {summaryOf(view)}
                          </span>
                          <span className="ws-view-row-check" aria-hidden="true">
                            {view.id === activeId ? <Check /> : null}
                          </span>
                        </button>
                        {canEdit ? (
                          <button
                            type="button"
                            className="ws-view-star"
                            data-active={board.defaultView === view.id}
                            title={board.defaultView === view.id ? "Clear default view" : "Make this the default view"}
                            aria-label={board.defaultView === view.id ? `Clear ${view.name} as default view` : `Make ${view.name} the default view`}
                            aria-pressed={board.defaultView === view.id}
                            onClick={() => onSetDefault(board.defaultView === view.id ? null : view.id)}
                          >
                            <Star />
                          </button>
                        ) : board.defaultView === view.id ? (
                          <span className="ws-view-star" data-active="true" title="Default view">
                            <Star />
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {canEdit && active ? (
                <div className="ws-view-actions">
                  {confirmDelete === active.id ? (
                    <span className="ws-view-confirm">
                      Delete “{active.name}”?
                      <button
                        type="button"
                        className="ws-view-delete"
                        onClick={() => {
                          onDelete(active.id);
                          setConfirmDelete(null);
                          setOpen(false);
                        }}
                      >
                        Delete
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)}>Keep</button>
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setRenameDraft(active.name);
                          setRenaming(active.id);
                        }}
                      >
                        <Pencil aria-hidden="true" /> Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(active.id)}
                      >
                        <Trash2 aria-hidden="true" /> Delete
                      </button>
                    </>
                  )}
                </div>
              ) : null}

              {canEdit ? (
                creating ? (
                  <form
                    className="ws-view-create"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = draftName.trim();
                      if (!name) return;
                      onSaveAs(name);
                      setDraftName("");
                      setCreating(false);
                      setOpen(false);
                    }}
                  >
                    <input
                      autoFocus
                      value={draftName}
                      maxLength={40}
                      placeholder="View name"
                      aria-label="New view name"
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setCreating(false);
                      }}
                    />
                    <button type="submit" className="btn btn-ghost" disabled={!draftName.trim()}>
                      Save
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="ws-view-new"
                    onClick={() => {
                      setDraftName(active ? `${active.name} copy` : "");
                      setCreating(true);
                    }}
                  >
                    <Plus aria-hidden="true" />
                    {active ? "Save current as a new view" : "Save current filters as a view"}
                  </button>
                )
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** What a saved view does, in as few words as the row can carry. */
function summaryOf(view: { filters: unknown[]; hiddenColumns?: string[] }): string {
  const parts = [];
  if (view.filters.length > 0) parts.push(`${view.filters.length} filter${view.filters.length === 1 ? "" : "s"}`);
  const hidden = view.hiddenColumns?.length ?? 0;
  if (hidden > 0) parts.push(`${hidden} hidden`);
  return parts.length > 0 ? parts.join(" · ") : "All columns";
}
