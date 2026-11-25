import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ArrowLeft, Lightbulb, Plus, X } from "lucide-react";

import type { BrainstormIdea, Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

const EMPTY: never[] = [];

const NODE_WIDTH = 156;
const NODE_GAP = 14;
const MAP_PADDING = 12;
const NODE_LINE_HEIGHT = 16.2;
const NODE_PADDING = 20;
const CENTER_HEIGHT = 50;

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
  const width = Math.min(220, Math.max(104, name.trim().length * 8.4 + 64));
  return rectAt({ x: size.width / 2, y: size.height / 2 }, width, CENTER_HEIGHT);
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
  const deleteBrainstormIdea = useWorkspaceStore((state) => state.deleteBrainstormIdea);
  const canWrite = ["owner", "manager", "editor"].includes(project.role);

  const mapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; pointerId: number; offsetX: number; offsetY: number } | null>(
    null,
  );
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [manual, setManual] = useState<Record<string, Point>>(() => readLayout(id));
  const [dragging, setDragging] = useState<{ id: string; point: Point } | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

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
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(layoutKey(id), JSON.stringify(manual));
    } catch {
      // A full quota must not stop the map from working.
    }
  }, [id, manual]);

  const center = useMemo(() => {
    if (!size.width || !size.height) return null;
    return {
      point: { x: size.width / 2, y: size.height / 2 },
      rect: centerRectFor(size, brainstorm?.name ?? ""),
    };
  }, [size, brainstorm?.name]);

  const positioned = useMemo<Positioned[]>(() => {
    if (!size.width || !size.height || !center) return [];
    const placed: Rect[] = [center.rect];
    return ideas
      .filter((idea) => idea.brainstormId === id)
      .map((idea, index) => {
        const height = nodeHeight(idea.text);
        const ideal = manual[idea.id] ?? idealPoint(index, size);
        const point = findFree(ideal, placed, size, NODE_WIDTH, height);
        placed.push(rectAt(point, NODE_WIDTH, height));
        return { idea, index, x: point.x, y: point.y, height };
      });
  }, [ideas, id, size, manual, center]);

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
    void deleteBrainstormIdea(idea.id);
  };

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
            {positioned.length} {positioned.length === 1 ? "idea" : "ideas"}
          </span>
        </div>
      </header>

      <div className="ws-brainstorm-body">
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
              className="ws-brainstorm-center"
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

          {positioned.length === 0 && (
            <p className="ws-brainstorm-empty">
              Add the first idea and watch the map grow.
            </p>
          )}
        </div>

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
    </div>
  );
}
