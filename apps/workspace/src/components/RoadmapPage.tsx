import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, animate, motion, useDragControls, useMotionValue } from "motion/react";
import { TextFieldDialog } from "@hook/ui";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import type { Milestone, MilestoneStatus, Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { DateCell } from "./DateCell";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EMPTY: never[] = [];
const STATUS: Array<{ id: MilestoneStatus; label: string; Icon: typeof Circle }> = [
  { id: "planned", label: "Planned", Icon: Circle },
  { id: "active", label: "In progress", Icon: Clock3 },
  { id: "done", label: "Done", Icon: CheckCircle2 },
];
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 1.6;

function dateBits(value: string | null) {
  if (!value) return { day: "", month: "" };
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return { day: "", month: "" };
  return { day, month: `${MONTHS[Number(month) - 1] ?? month} ${year.slice(2)}` };
}

function dayAfter(value: string | null): string | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const next = new Date(year, month - 1, day + 1, 12);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function fullDate(value: string | null): string {
  if (!value) return "No date yet";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function sortMilestones(items: Milestone[]): Milestone[] {
  return [...items].sort((left, right) => {
    if (left.dueDate && right.dueDate) return left.dueDate.localeCompare(right.dueDate);
    if (left.dueDate) return -1;
    if (right.dueDate) return 1;
    return left.position - right.position || left.createdAt - right.createdAt;
  });
}

/** A roadmap: one horizontal line of milestone circles with an editor drawer. */
export function RoadmapPage({
  id,
  project,
}: {
  id: string;
  project: Project;
}) {
  const roadmap = useWorkspaceStore(
    (state) => (state.roadmaps[project.id] ?? EMPTY).find((item) => item.id === id),
  );
  const milestones = useWorkspaceStore((state) => state.milestones[project.id] ?? EMPTY);
  const loadRoadmap = useWorkspaceStore((state) => state.loadRoadmap);
  const createMilestone = useWorkspaceStore((state) => state.createMilestone);
  const updateMilestone = useWorkspaceStore((state) => state.updateMilestone);
  const deleteMilestone = useWorkspaceStore((state) => state.deleteMilestone);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorOrigin, setEditorOrigin] = useState<{ x: number; y: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [insertAfterId, setInsertAfterId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<MilestoneStatus>("planned");
  const [saving, setSaving] = useState(false);
  const [maxDrag, setMaxDrag] = useState(0);
  const maxDragRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState(1);
  const suppressClick = useRef(false);
  const activeNode = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const wheelTarget = useRef(0);
  const wheelFrame = useRef<number | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const dragControls = useDragControls();
  const readOnly = project.role === "viewer";

  const timeline = useMemo(
    () => sortMilestones(milestones.filter((milestone) => milestone.roadmapId === id)),
    [milestones, id],
  );
  const selected = timeline.find((milestone) => milestone.id === selectedId) ?? null;

  const stopWheel = () => {
    if (wheelFrame.current !== null) {
      cancelAnimationFrame(wheelFrame.current);
      wheelFrame.current = null;
    }
  };

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        stopWheel();
        x.stop();
        setZoom((current) =>
          Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * Math.exp(-event.deltaY * 0.0015))),
        );
        return;
      }
      if (!maxDrag) return;
      event.preventDefault();
      x.stop();
      if (wheelFrame.current === null) wheelTarget.current = x.get();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * scale;
      wheelTarget.current = Math.max(-maxDrag, Math.min(0, wheelTarget.current - delta));
      if (wheelFrame.current !== null) return;
      const tick = () => {
        const target = wheelTarget.current;
        const current = x.get();
        const next = current + (target - current) * 0.22;
        if (Math.abs(target - next) < 0.4) {
          x.set(target);
          wheelFrame.current = null;
          return;
        }
        x.set(next);
        wheelFrame.current = requestAnimationFrame(tick);
      };
      wheelFrame.current = requestAnimationFrame(tick);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      stopWheel();
    };
  }, [maxDrag, x]);

  useEffect(() => {
    if (!roadmap) void loadRoadmap(id);
  }, [id, roadmap, loadRoadmap]);

  useEffect(() => {
    if (!editorOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditorOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [editorOpen]);

  useEffect(() => {
    setSelectedId((current) => {
      if (current && timeline.some((milestone) => milestone.id === current)) return current;
      return timeline[0]?.id ?? null;
    });
  }, [timeline]);

  useEffect(() => {
    if (!selected) return;
    setTitle(selected.title);
    setDescription(selected.description);
    setDueDate(selected.dueDate ?? "");
    setStatus(selected.status);
  }, [selected?.id]);

  useLayoutEffect(() => {
    const measure = () => {
      const v = viewport.current;
      const t = track.current;
      if (!v || !t) return;
      const overflow = Math.max(0, t.scrollWidth - v.clientWidth);
      const max = overflow;
      maxDragRef.current = max;
      setMaxDrag(max);
      if (x.get() < -max) x.set(-max);
      if (x.get() > 0) x.set(0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (viewport.current) observer.observe(viewport.current);
    if (track.current) observer.observe(track.current);
    return () => observer.disconnect();
  }, [editorOpen, timeline.length, x, zoom]);

  useEffect(() => {
    if (editorOpen) return;
    const frame = requestAnimationFrame(() => {
      const v = viewport.current;
      const node = activeNode.current;
      if (!v || !node) return;
      const vRect = v.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const margin = 48;
      const left = nodeRect.left - vRect.left;
      const right = left + nodeRect.width;
      const visibleRight = vRect.width - margin;
      let delta = 0;
      if (right > visibleRight) delta = visibleRight - right;
      else if (left < margin) delta = margin - left;
      if (delta === 0) return;
      const target = Math.max(-maxDragRef.current, Math.min(0, x.get() + delta));
      animate(x, target, { type: "spring", stiffness: 300, damping: 34, mass: 0.7 });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.id, editorOpen, timeline.length, x]);

  const save = async (patch: Partial<Milestone>) => {
    if (!selected) return;
    setSaving(true);
    const saved = await updateMilestone(selected.id, patch);
    setSaving(false);
    if (!saved) return;
  };

  const choose = (milestone: Milestone, element: HTMLElement) => {
    if (suppressClick.current) return;
    const box = page.current?.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    setEditorOrigin(
      box
        ? {
            x: rect.left + rect.width / 2 - (box.left + box.width / 2),
            y: rect.top + rect.height / 2 - (box.top + box.height / 2),
          }
        : null,
    );
    setSelectedId(milestone.id);
    setEditorOpen(true);
  };

  const removeSelected = () => {
    if (!selected) return;
    const next = timeline.find((milestone) => milestone.id !== selected.id) ?? null;
    if (!confirm("Delete this milestone for everyone?")) return;
    void deleteMilestone(selected.id).then(() => {
      setSelectedId(next?.id ?? null);
      setEditorOpen(false);
      setEditorOrigin(null);
    });
  };

  const openCreate = (after: Milestone | null) => {
    setInsertAfterId(after?.id ?? null);
    setNewTitle("");
    setEditorOrigin(null);
    setCreating(true);
  };

  const addMilestone = () => {
    const value = newTitle.trim();
    if (!value || !roadmap) return;
    const previous = insertAfterId
      ? timeline.find((milestone) => milestone.id === insertAfterId) ?? null
      : null;
    setCreating(false);
    setNewTitle("");
    void createMilestone(roadmap.id, value, {
      dueDate: dayAfter(previous?.dueDate ?? null),
      position: previous ? previous.position + 1 : 0,
    }).then((milestone) => {
      if (!milestone) return;
      setInsertAfterId(null);
      setSelectedId(milestone.id);
      setEditorOrigin(null);
      setEditorOpen(true);
    });
  };

  const panBy = (delta: number) => {
    const next = Math.max(-maxDrag, Math.min(0, x.get() + delta));
    animate(x, next, { type: "spring", stiffness: 380, damping: 38, mass: 0.6 });
  };

  if (!roadmap) {
    return <section className="ws-empty">Opening…</section>;
  }

  return (
    <div className="ws-milestones-page" ref={page}>
      <header className="ws-page-head">
        <div className="ws-page-title">
          <span className="ws-page-kicker">Roadmap</span>
          <h1>{roadmap.name || "Untitled"}</h1>
          <p>
            {timeline.length === 0
              ? "Add the first milestone to start this roadmap"
              : `${timeline.length === 1 ? "1 milestone" : `${timeline.length} milestones`} · Drag sideways or use Ctrl + wheel to zoom`}
          </p>
        </div>
        <div className="ws-page-actions">
          {timeline.length > 0 ? (
            <div className="ws-roadmap-zoom" role="group" aria-label="Zoom">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current / 1.12))}
              >
                <Minus aria-hidden="true" />
              </button>
              <button
                type="button"
                className="ws-zoom-value"
                title="Reset zoom"
                aria-label={`Roadmap zoom ${Math.round(zoom * 100)} percent. Reset zoom.`}
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current * 1.12))}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openCreate(timeline[timeline.length - 1] ?? null)}
            >
              <Plus aria-hidden="true" />
              New milestone
            </button>
          ) : null}
        </div>
      </header>

      <div
        ref={viewport}
        className="ws-timeline-scroll"
        data-dragging={dragging}
        tabIndex={0}
        role="region"
        aria-label="Roadmap timeline"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            panBy(-320);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            panBy(320);
          }
        }}
      >
        <div
          className="ws-timeline-drag-surface"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if ((event.target as Element).closest("button")) return;
            dragControls.start(event);
          }}
        >
          <motion.div
            className="ws-timeline-pan"
            style={{ x }}
            drag="x"
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ left: -maxDrag, right: 0 }}
            dragElastic={0.14}
            dragMomentum
            dragTransition={{ power: 0.32, timeConstant: 300, bounceStiffness: 260, bounceDamping: 28 }}
            onDragStart={() => {
              stopWheel();
              setDragging(true);
              suppressClick.current = false;
            }}
            onDrag={(_, info) => {
              if (Math.abs(info.offset.x) > 4) suppressClick.current = true;
            }}
            onDragEnd={() => {
              setDragging(false);
              window.setTimeout(() => {
                suppressClick.current = false;
              }, 0);
            }}
          >
            <div
              ref={track}
              className="ws-timeline"
              style={{ "--roadmap-zoom": zoom } as CSSProperties}
              role="list"
              aria-label="Milestones"
            >
          <motion.div
            className="ws-timeline-line"
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: 1 }}
            transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
          />
          <div className="ws-timeline-gap" data-spacer="true" aria-hidden="true" />
          {timeline.map((milestone, index) => {
            const active = milestone.id === selectedId;
            const date = dateBits(milestone.dueDate);
            return (
              <Fragment key={milestone.id}>
                <motion.button
                  ref={active ? activeNode : undefined}
                  type="button"
                  role="listitem"
                  className="ws-timeline-node"
                  data-status={milestone.status}
                  data-active={active}
                  aria-pressed={active}
                  aria-label={
                    milestone.dueDate
                      ? `${milestone.title || "Untitled"}, ${fullDate(milestone.dueDate)}`
                      : milestone.title || "Untitled"
                  }
                  onClick={(event) => choose(milestone, event.currentTarget)}
                  initial={{ opacity: 0, y: 28, scale: 0.86 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: 0.05 + index * 0.06, type: "spring", stiffness: 240, damping: 24 }}
                  whileHover={{ y: -6, scale: 1.035 }}
                  whileTap={{ scale: 0.98 }}
                >
                  {active ? (
                    <motion.span
                      layoutId="ws-milestone-active-ring"
                      className="ws-timeline-ring"
                      transition={{ type: "spring", stiffness: 320, damping: 30 }}
                    />
                  ) : null}
                  <span className="ws-timeline-badge">
                    {STATUS.find((entry) => entry.id === milestone.status)?.label}
                  </span>
                  {milestone.dueDate ? (
                    <span className="ws-timeline-date">
                      <strong>{date.day}</strong>
                      <small>{date.month}</small>
                    </span>
                  ) : null}
                  <span className="ws-timeline-title">{milestone.title || "Untitled"}</span>
                  {milestone.description.trim() ? (
                    <span className="ws-timeline-preview">{milestone.description}</span>
                  ) : null}
                </motion.button>
                <div className="ws-timeline-gap" data-edge={index === timeline.length - 1}>
                  {!readOnly ? (
                    <button
                      type="button"
                      className="ws-timeline-insert"
                      aria-label={`Add milestone after ${milestone.title || "Untitled"}`}
                      title="Add milestone here"
                      onClick={() => openCreate(milestone)}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
            </div>
          </motion.div>
        </div>
      </div>

      <AnimatePresence>
        {editorOpen && selected ? (
          <motion.div
            className="ws-milestone-focus-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setEditorOpen(false)}
          >
            <motion.div
              className="ws-milestone-focus"
              data-status={status}
              role="dialog"
              aria-modal="true"
              aria-label={`Edit ${selected.title || "milestone"}`}
              initial={{
                x: editorOrigin?.x ?? 0,
                y: editorOrigin?.y ?? 0,
                scale: editorOrigin ? 0.35 : 0.9,
                opacity: 0,
              }}
              animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: "spring", stiffness: 280, damping: 30, mass: 0.8 }}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                className="ws-milestone-focus-close"
                aria-label="Close milestone"
                onClick={() => setEditorOpen(false)}
              >
                <X aria-hidden="true" />
              </button>

              <div className="ws-milestone-focus-kicker">Milestone</div>
              <div className="ws-milestone-statuses ws-milestone-focus-statuses">
                {STATUS.map(({ id: value, label, Icon }) => (
                  <button
                    key={value}
                    type="button"
                    className="ws-milestone-status"
                    data-status={value}
                    data-active={status === value}
                    aria-pressed={status === value}
                    disabled={readOnly}
                    onClick={() => {
                      setStatus(value);
                      void save({ status: value });
                    }}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <input
                className="ws-milestone-focus-title"
                value={title}
                readOnly={readOnly}
                aria-label="Milestone title"
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => {
                  const next = title.trim();
                  if (next && next !== selected.title) void save({ title: next });
                }}
              />

              <div className="ws-milestone-field ws-milestone-field-date ws-milestone-focus-date">
                <span><CalendarDays aria-hidden="true" />Target date</span>
                <DateCell
                  value={dueDate}
                  type="date"
                  label="Target date"
                  disabled={readOnly}
                  onChange={(next) => {
                    setDueDate(next);
                    void save({ dueDate: next || null });
                  }}
                />
              </div>

              <label className="ws-milestone-field ws-milestone-notes ws-milestone-focus-notes">
                <span>Description</span>
                <textarea
                  value={description}
                  readOnly={readOnly}
                  aria-label="Milestone description"
                  placeholder="What does this milestone mean?"
                  onChange={(event) => setDescription(event.target.value)}
                  onBlur={() => {
                    if (description !== selected.description) void save({ description });
                  }}
                />
              </label>

              <div className="ws-milestone-focus-foot">
                <span className="ws-document-state" data-dirty={saving}>
                  {!saving && <Check aria-hidden="true" />}
                  {saving ? "Saving…" : "Saved"}
                </span>
                <span>Updated {new Date(selected.updatedAt).toLocaleDateString("en-GB")}</span>
                {!readOnly ? (
                  <button
                    type="button"
                    className="ws-milestone-delete"
                    aria-label="Delete milestone"
                    title="Delete milestone"
                    onClick={removeSelected}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <TextFieldDialog
        open={creating}
        title="New milestone"
        description="A point on this roadmap. You can set its date, status and description after it exists."
        label="Title"
        placeholder="Public beta"
        value={newTitle}
        onChange={setNewTitle}
        confirm="Create milestone"
        onClose={() => {
          setCreating(false);
          setNewTitle("");
          setInsertAfterId(null);
        }}
        onConfirm={addMilestone}
      />
    </div>
  );
}
