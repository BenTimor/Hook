import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { TextFieldDialog } from "@hook/ui";
import {
  ArrowLeft,
  GripVertical,
  Lightbulb,
  List,
  Network,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import type { BrainstormIdea, Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { PopupMenu, type MenuEntry } from "./PopupMenu";

const EMPTY: never[] = [];

const NODE_WIDTH = 156;
const NODE_GAP = 14;
const MAP_PADDING = 12;
const NODE_LINE_HEIGHT = 16.2;
const NODE_PADDING = 20;
const CENTER_HEIGHT = 64;
const CENTER_MAX_WIDTH = 320;
const VIEW_KEY = "hook.workspace.brainstorm.view";

type BrainstormView = "map" | "list";
type Point = { x: number; y: number };
type Size = { width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };

function nodeHeight(text: string) {
  const lines = Math.max(1, Math.ceil(text.length / 17));
  return NODE_PADDING + lines * NODE_LINE_HEIGHT;
}

function rectAt(point: Point, width: number, height: number): Rect {
  return {
    x: point.x - width / 2,
    y: point.y - height / 2,
    width,
    height,
  };
}

function overlaps(left: Rect, right: Rect, gap = NODE_GAP) {
  return (
    left.x < right.x + right.width + gap &&
    left.x + left.width + gap > right.x &&
    left.y < right.y + right.height + gap &&
    left.y + left.height + gap > right.y
  );
}

function clamp(value: number, min: number, max: number) {
  return max < min ? (min + max) / 2 : Math.min(Math.max(value, min), max);
}

function clampPoint(point: Point, size: Size, width: number, height: number): Point {
  return {
    x: clamp(point.x, MAP_PADDING + width / 2, size.width - MAP_PADDING - width / 2),
    y: clamp(point.y, MAP_PADDING + height / 2, size.height - MAP_PADDING - height / 2),
  };
}

function idealPoint(index: number, size: Size): Point {
  let ring = 1;
  let start = 0;
  let slots = 6;
  while (index >= start + slots) {
    start += slots;
    slots += 6;
    ring += 1;
  }
  const angle = ((index - start) / slots) * Math.PI * 2 - Math.PI / 2 + ring * 0.35;
  const maxRadius = Math.max(80, Math.min(size.width, size.height) / 2 - 110);
  const radius = Math.min(150 + (ring - 1) * 105, maxRadius);
  return {
    x: size.width / 2 + Math.cos(angle) * radius,
    y: size.height / 2 + Math.sin(angle) * radius,
  };
}

/**
 * The nearest spot to `ideal` where a card fits without touching what is
 * already on the map. A spiral is tried first, then a coarse grid, so a drag
 * landing on another card slides to the closest free place instead of stacking.
 */
function findFree(
  ideal: Point,
  placed: Rect[],
  size: Size,
  width: number,
  height: number,
): Point {
  const start = clampPoint(ideal, size, width, height);
  const fits = (point: Point) => {
    const rect = rectAt(point, width, height);
    return !placed.some((other) => overlaps(rect, other));
  };
  if (fits(start)) return start;

  for (let step = 1; step <= 120; step += 1) {
    const radius = step * 9;
    const samples = Math.max(10, Math.ceil((Math.PI * 2 * radius) / 22));
    for (let sample = 0; sample < samples; sample += 1) {
      const angle = (sample / samples) * Math.PI * 2 + step * 0.7;
      const point = clampPoint(
        {
          x: ideal.x + Math.cos(angle) * radius,
          y: ideal.y + Math.sin(angle) * radius,
        },
        size,
        width,
        height,
      );
      if (fits(point)) return point;
    }
  }

  const stepX = width + NODE_GAP;
  const stepY = height + NODE_GAP;
  for (let y = MAP_PADDING + height / 2; y <= size.height - MAP_PADDING; y += stepY) {
    for (let x = MAP_PADDING + width / 2; x <= size.width - MAP_PADDING; x += stepX) {
      const point = { x, y };
      if (fits(point)) return point;
    }
  }
  return start;
}

function centerRectFor(size: Size, name: string): Rect {
  const width = Math.min(
    CENTER_MAX_WIDTH,
    Math.max(132, name.trim().length * 8.8 + 64),
    Math.max(132, size.width - MAP_PADDING * 2),
  );
  return rectAt({ x: size.width / 2, y: size.height / 2 }, width, CENTER_HEIGHT);
}

function readView(): BrainstormView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "map";
  } catch {
    return "map";
  }
}

function layoutKey(id: string) {
  return `hook.workspace.brainstorm.${id}.layout`;
}

function readLayout(id: string): Record<string, Point> {
  try {
    const stored = JSON.parse(localStorage.getItem(layoutKey(id)) ?? "{}") as unknown;
    if (!stored || typeof stored !== "object") return {};
    return Object.fromEntries(
      Object.entries(stored).flatMap(([key, value]) => {
        if (!value || typeof value !== "object") return [];
        const point = value as Partial<Point>;
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
        return [[key, { x: point.x as number, y: point.y as number }]];
      }),
    );
  } catch {
    return {};
  }
}

type Positioned = {
  idea: BrainstormIdea;
  index: number;
  x: number;
  y: number;
  height: number;
};

/**
 * A brainstorm: one word in the middle and ideas around it.
 *
 * Cards are placed in a non-overlapping layout from the order the ideas
 * arrived in. A card can be dragged anywhere free; its spot is remembered on
 * this device, and every other card keeps its place.
 */
export function BrainstormPage({
  id,
  project,
  onBack,
}: {
  id: string;
  project: Project;
  onBack: () => void;
}) {
  const brainstorm = useWorkspaceStore(
    (state) => state.brainstorms[project.id]?.find((item) => item.id === id) ?? null,
  );
  const ideas = useWorkspaceStore((state) => state.brainstormIdeas[project.id] ?? EMPTY);
  const loadBrainstorm = useWorkspaceStore((state) => state.loadBrainstorm);
  const createBrainstormIdea = useWorkspaceStore((state) => state.createBrainstormIdea);
  const updateBrainstormIdea = useWorkspaceStore((state) => state.updateBrainstormIdea);
  const reorderBrainstormIdeas = useWorkspaceStore((state) => state.reorderBrainstormIdeas);
  const deleteBrainstormIdea = useWorkspaceStore((state) => state.deleteBrainstormIdea);
  const canWrite = ["owner", "manager", "editor"].includes(project.role);

  const mapRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; pointerId: number; offsetX: number; offsetY: number } | null>(
    null,
  );
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [centerSize, setCenterSize] = useState<Size>({ width: 0, height: 0 });
  const [manual, setManual] = useState<Record<string, Point>>(() => readLayout(id));
  const [dragging, setDragging] = useState<{ id: string; point: Point } | null>(null);
  const [view, setView] = useState<BrainstormView>(readView);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; idea: BrainstormIdea } | null>(null);
  const [editing, setEditing] = useState<BrainstormIdea | null>(null);
  const [editText, setEditText] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ id: string; after: boolean } | null>(null);

  useEffect(() => {
    if (!brainstorm) void loadBrainstorm(id);
  }, [brainstorm, id, loadBrainstorm]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const measure = () =>
      setSize({ width: map.clientWidth, height: map.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(map);
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => {
    const node = centerRef.current;
    if (!node) return;
    const measure = () =>
      setCenterSize({ width: node.offsetWidth, height: node.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [brainstorm?.name, view]);

  useEffect(() => {
    try {
      localStorage.setItem(layoutKey(id), JSON.stringify(manual));
    } catch {
      // A full quota must not stop the map from working.
    }
  }, [id, manual]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Remembering the view is a convenience, not a requirement.
    }
  }, [view]);

  const items = useMemo(
    () => ideas.filter((idea) => idea.brainstormId === id),
    [ideas, id],
  );

  const center = useMemo(() => {
    if (!size.width || !size.height) return null;
    const fallback = centerRectFor(size, brainstorm?.name ?? "");
    const maxWidth = Math.max(132, size.width - MAP_PADDING * 2);
    const width = Math.min(centerSize.width || fallback.width, maxWidth);
    const height = Math.min(
      centerSize.height || fallback.height,
      Math.max(CENTER_HEIGHT, size.height - MAP_PADDING * 2),
    );
    return {
      point: { x: size.width / 2, y: size.height / 2 },
      rect: rectAt({ x: size.width / 2, y: size.height / 2 }, width, height),
    };
  }, [size, centerSize, brainstorm?.name]);

  const positioned = useMemo<Positioned[]>(() => {
    if (!size.width || !size.height || !center) return [];
    const placed: Rect[] = [center.rect];
    return items.map((idea, index) => {
      const height = nodeHeight(idea.text);
      const ideal = manual[idea.id] ?? idealPoint(index, size);
      const point = findFree(ideal, placed, size, NODE_WIDTH, height);
      placed.push(rectAt(point, NODE_WIDTH, height));
      return { idea, index, x: point.x, y: point.y, height };
    });
  }, [items, size, manual, center]);

  const visible = positioned.map((node) =>
    dragging && dragging.id === node.idea.id
      ? { ...node, x: dragging.point.x, y: dragging.point.y }
      : node,
  );

  const addIdea = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true);
    const created = await createBrainstormIdea(id, value);
    setSaving(false);
    if (created) setText("");
  };

  const removeIdea = (idea: BrainstormIdea) => {
    if (editing?.id === idea.id) setEditing(null);
    void deleteBrainstormIdea(idea.id);
  };

  const openEdit = (idea: BrainstormIdea) => {
    setEditing(idea);
    setEditText(idea.text);
  };

  const saveEdit = async () => {
    if (!editing || editSaving) return;
    const value = editText.trim();
    if (!value) return;
    setEditSaving(true);
    const saved = await updateBrainstormIdea(editing.id, { text: value });
    setEditSaving(false);
    if (saved) setEditing(null);
  };

  const openMenu = (event: ReactMouseEvent, idea: BrainstormIdea) => {
    if (!canWrite) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, idea });
  };

  const dropIdea = (targetId: string | null, after: boolean) => {
    const source = dragId;
    setDragId(null);
    setDragOver(null);
    if (!source || source === targetId) return;
    const ids = items.map((idea) => idea.id).filter((id) => id !== source);
    let index = targetId ? ids.indexOf(targetId) : -1;
    if (index < 0) index = ids.length;
    else if (after) index += 1;
    ids.splice(index, 0, source);
    void reorderBrainstormIdeas(id, ids);
  };

  const startRowDrag = (event: ReactDragEvent<HTMLDivElement>, idea: BrainstormIdea) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", idea.id);
    event.dataTransfer.setDragImage(event.currentTarget, 24, 24);
    setDragId(idea.id);
    setDragOver(null);
  };

  const menuEntries: MenuEntry[] = menu
    ? [
        {
          kind: "action",
          label: "Edit idea",
          icon: <Pencil />,
          onSelect: () => openEdit(menu.idea),
        },
        { kind: "separator" },
        {
          kind: "action",
          label: "Delete idea",
          icon: <Trash2 />,
          danger: true,
          onSelect: () => removeIdea(menu.idea),
        },
      ]
    : [];

  const occupied = (excludeId?: string) => {
    const rects = center ? [center.rect] : [];
    for (const node of positioned) {
      if (node.idea.id === excludeId) continue;
      rects.push(rectAt({ x: node.x, y: node.y }, NODE_WIDTH, node.height));
    }
    return rects;
  };

  const startDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    node: Positioned,
  ) => {
    if (event.button !== 0) return;
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: node.idea.id,
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left - node.x,
      offsetY: event.clientY - bounds.top - node.y,
    };
    setDragging({ id: node.idea.id, point: { x: node.x, y: node.y } });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>, node: Positioned) => {
    const drag = dragRef.current;
    const map = mapRef.current;
    if (!drag || !map || drag.pointerId !== event.pointerId) return;
    const bounds = map.getBoundingClientRect();
    const ideal = {
      x: event.clientX - bounds.left - drag.offsetX,
      y: event.clientY - bounds.top - drag.offsetY,
    };
    const point = findFree(
      ideal,
      occupied(node.idea.id),
      size,
      NODE_WIDTH,
      node.height,
    );
    setDragging({ id: node.idea.id, point });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, node: Positioned) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const point = dragging?.point ?? { x: node.x, y: node.y };
    const free = findFree(
      point,
      occupied(node.idea.id),
      size,
      NODE_WIDTH,
      node.height,
    );
    setManual((current) => ({ ...current, [node.idea.id]: free }));
    setDragging(null);
  };

  return (
    <div className="ws-page ws-brainstorm">
      <header className="ws-page-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back to project">
          <ArrowLeft />
        </button>
        <div className="ws-page-title">
          <h1>{brainstorm?.name || "Brainstorm"}</h1>
          <span>
            {items.length} {items.length === 1 ? "idea" : "ideas"}
          </span>
        </div>
        <div className="ws-page-actions">
          <div className="ws-segment" role="tablist" aria-label="Brainstorm view">
            <button
              type="button"
              role="tab"
              aria-selected={view === "map"}
              data-active={view === "map"}
              onClick={() => setView("map")}
              title="Map view"
            >
              <Network strokeWidth={1.8} />
              Map
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "list"}
              data-active={view === "list"}
              onClick={() => setView("list")}
              title="List view"
            >
              <List strokeWidth={1.8} />
              List
            </button>
          </div>
        </div>
      </header>

      <div className="ws-brainstorm-body" data-view={view}>
        {view === "map" ? (
        <div className="ws-brainstorm-map" ref={mapRef}>
          {center && (
            <svg
              className="ws-brainstorm-links"
              width={size.width}
              height={size.height}
              viewBox={`0 0 ${size.width} ${size.height}`}
              aria-hidden="true"
            >
              {visible.map(({ idea, x, y }) => (
                <line
                  key={idea.id}
                  x1={center.point.x}
                  y1={center.point.y}
                  x2={x}
                  y2={y}
                />
              ))}
            </svg>
          )}

          {center && (
            <div
              ref={centerRef}
              className="ws-brainstorm-center"
              dir="auto"
              style={{ left: `${center.point.x}px`, top: `${center.point.y}px` }}
            >
              <Lightbulb aria-hidden="true" />
              <span>{brainstorm?.name || "Untitled"}</span>
            </div>
          )}

          {visible.map((node) => (
            <div
              className="ws-brainstorm-node"
              key={node.idea.id}
              dir="auto"
              data-dragging={dragging?.id === node.idea.id}
              style={{
                left: `${node.x}px`,
                top: `${node.y}px`,
                animationDelay: `${Math.min(node.index, 14) * 32}ms`,
              }}
              onPointerDown={(event) => startDrag(event, node)}
              onPointerMove={(event) => moveDrag(event, node)}
              onPointerUp={(event) => endDrag(event, node)}
              onPointerCancel={(event) => endDrag(event, node)}
              onContextMenu={(event) => openMenu(event, node.idea)}
            >
              <span>{node.idea.text}</span>
              {canWrite && (
                <button
                  className="ws-brainstorm-node-remove"
                  aria-label="Remove idea"
                  title="Remove idea"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => removeIdea(node.idea)}
                >
                  <X />
                </button>
              )}
            </div>
          ))}

          {items.length === 0 && (
            <p className="ws-brainstorm-empty">
              Add the first idea and watch the map grow.
            </p>
          )}
        </div>
        ) : (
          <div
            className="ws-brainstorm-list"
            role="list"
            aria-label="Ideas"
            data-dragging={Boolean(dragId)}
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const target = event.target instanceof Element ? event.target : null;
              const row = target?.closest<HTMLElement>(".ws-brainstorm-list-row[data-idea-id]");
              const targetId = row?.dataset.ideaId;
              if (!row || !targetId) {
                setDragOver(null);
                return;
              }
              const rect = row.getBoundingClientRect();
              const after = event.clientY > rect.top + rect.height / 2;
              if (dragOver?.id !== targetId || dragOver.after !== after) {
                setDragOver({ id: targetId, after });
              }
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              setDragOver(null);
            }}
            onDrop={(event) => {
              if (!dragId) return;
              event.preventDefault();
              const target = event.target instanceof Element ? event.target : null;
              const row = target?.closest<HTMLElement>(".ws-brainstorm-list-row[data-idea-id]");
              const targetId = row?.dataset.ideaId;
              if (!row || !targetId) {
                dropIdea(null, true);
                return;
              }
              const rect = row.getBoundingClientRect();
              dropIdea(targetId, event.clientY > rect.top + rect.height / 2);
            }}
          >
            {items.map((idea, index) => (
              <div
                className="ws-brainstorm-list-row"
                key={idea.id}
                role="listitem"
                dir="auto"
                data-idea-id={idea.id}
                data-dragging={dragId === idea.id}
                data-over={
                  dragId && dragId !== idea.id && dragOver?.id === idea.id
                    ? dragOver.after
                      ? "after"
                      : "before"
                    : undefined
                }
                draggable={canWrite}
                onDragStart={canWrite ? (event) => startRowDrag(event, idea) : undefined}
                onDragEnd={() => {
                  setDragId(null);
                  setDragOver(null);
                }}
                onContextMenu={(event) => openMenu(event, idea)}
              >
                {canWrite && (
                  <span className="ws-brainstorm-list-grip" aria-hidden="true">
                    <GripVertical />
                  </span>
                )}
                <span className="ws-brainstorm-list-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="ws-brainstorm-list-text">{idea.text}</span>
                {canWrite && (
                  <button
                    className="ws-brainstorm-node-remove"
                    aria-label="Remove idea"
                    title="Remove idea"
                    draggable={false}
                    onClick={() => removeIdea(idea)}
                  >
                    <X />
                  </button>
                )}
              </div>
            ))}
            {items.length === 0 && (
              <p className="ws-brainstorm-list-empty">
                Add the first idea and it will appear here.
              </p>
            )}
          </div>
        )}

        {canWrite && (
          <form className="ws-brainstorm-composer" onSubmit={addIdea}>
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Add an idea"
              aria-label="Add an idea"
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!text.trim() || saving}
            >
              <Plus />
              Add
            </button>
          </form>
        )}
      </div>

      {menu ? (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <TextFieldDialog
        open={editing !== null}
        title="Edit idea"
        description="Change the text of this idea for everyone in the project."
        label="Idea"
        placeholder="The idea"
        value={editText}
        onChange={setEditText}
        confirm={editSaving ? "Saving…" : "Save idea"}
        onClose={() => setEditing(null)}
        onConfirm={() => void saveEdit()}
      />
    </div>
  );
}
