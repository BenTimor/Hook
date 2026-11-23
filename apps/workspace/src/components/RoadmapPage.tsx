import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TextFieldDialog } from "@hook/ui";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
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

function dateBits(value: string | null) {
  if (!value) return { day: "—", month: "No date" };
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return { day: "—", month: "No date" };
  return { day, month: `${MONTHS[Number(month) - 1] ?? month} ${year.slice(2)}` };
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
  const [editorOpen, setEditorOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<MilestoneStatus>("planned");
  const [saving, setSaving] = useState(false);
  const [panning, setPanning] = useState(false);
  const activeNode = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; left: number } | null>(null);
  const readOnly = project.role === "viewer";

  const timeline = useMemo(
    () => sortMilestones(milestones.filter((milestone) => milestone.roadmapId === id)),
    [milestones, id],
  );
  const selected = timeline.find((milestone) => milestone.id === selectedId) ?? null;

  useEffect(() => {
    if (!roadmap) void loadRoadmap(id);
  }, [id, roadmap, loadRoadmap]);

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

  useEffect(() => {
    activeNode.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [selected?.id, timeline.length]);

  const save = async (patch: Partial<Milestone>) => {
    if (!selected) return;
    setSaving(true);
    const saved = await updateMilestone(selected.id, patch);
    setSaving(false);
    if (!saved) return;
  };

  const choose = (milestone: Milestone) => {
    setSelectedId(milestone.id);
    setEditorOpen(true);
  };

  const removeSelected = () => {
    if (!selected) return;
    const next = timeline.find((milestone) => milestone.id !== selected.id) ?? null;
    if (!confirm("Delete this milestone for everyone?")) return;
    void deleteMilestone(selected.id).then(() => {
      setSelectedId(next?.id ?? null);
      setEditorOpen(Boolean(next));
    });
  };

  const addMilestone = () => {
    const value = newTitle.trim();
    if (!value || !roadmap) return;
    setCreating(false);
    setNewTitle("");
    void createMilestone(roadmap.id, value).then((milestone) => {
      if (!milestone) return;
      setSelectedId(milestone.id);
      setEditorOpen(true);
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    drag.current = { x: event.clientX, left: event.currentTarget.scrollLeft };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    event.currentTarget.scrollLeft = current.left - (event.clientX - current.x);
  };
  const stopPanning = (event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!roadmap) {
    return <section className="ws-empty">Opening…</section>;
  }

  return (
    <div className="ws-milestones-page">
      <header className="ws-milestones-hero">
        <div>
          <span>Roadmap</span>
          <h1>{roadmap.name || "Untitled"}</h1>
        </div>
        <div className="ws-milestones-hero-actions">
          <p>
            {timeline.length === 1 ? "1 milestone" : `${timeline.length} milestones`}
            <small>Click a circle to open it. Drag or scroll sideways.</small>
          </p>
          {!readOnly ? (
            <button type="button" className="ws-milestones-add" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              New milestone
            </button>
          ) : null}
        </div>
      </header>

      <div
        ref={scroll}
        className="ws-timeline-scroll"
        data-drawer={editorOpen && Boolean(selected)}
        data-panning={panning}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopPanning}
        onPointerCancel={stopPanning}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
          event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        <div
          className="ws-timeline"
          data-few={timeline.length <= 2}
          role="list"
          aria-label="Milestones"
        >
          <motion.div
            className="ws-timeline-line"
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: 1 }}
            transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
          />
          {timeline.map((milestone, index) => {
            const active = milestone.id === selectedId;
            const date = dateBits(milestone.dueDate);
            return (
              <motion.button
                key={milestone.id}
                ref={active ? activeNode : undefined}
                type="button"
                role="listitem"
                className="ws-timeline-node"
                data-status={milestone.status}
                data-active={active}
                aria-pressed={active}
                aria-label={`${milestone.title || "Untitled"}, ${fullDate(milestone.dueDate)}`}
                onClick={() => choose(milestone)}
                initial={{ opacity: 0, y: 28, scale: 0.86 }}
                animate={{ opacity: 1, y: 0, scale: active ? 1.06 : 1 }}
                transition={{ delay: 0.05 + index * 0.06, type: "spring", stiffness: 240, damping: 24 }}
                whileHover={{ y: -6, scale: active ? 1.1 : 1.045 }}
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
                <span className="ws-timeline-date">
                  <strong>{date.day}</strong>
                  <small>{date.month}</small>
                </span>
                <span className="ws-timeline-title">{milestone.title || "Untitled"}</span>
                <span className="ws-timeline-preview">
                  {milestone.description.trim() || "No description yet."}
                </span>
              </motion.button>
            );
          })}
          {!readOnly ? (
            <motion.button
              type="button"
              role="listitem"
              className="ws-timeline-add"
              aria-label="Add milestone"
              onClick={() => setCreating(true)}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.08 + timeline.length * 0.06, type: "spring", stiffness: 240, damping: 24 }}
              whileHover={{ y: -4, scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
            >
              <Plus aria-hidden="true" />
              <span>Add milestone</span>
            </motion.button>
          ) : null}
        </div>
      </div>

      <AnimatePresence>
        {editorOpen && selected ? (
          <motion.aside
            className="ws-milestone-drawer"
            aria-label="Edit milestone"
            initial={{ x: 430, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 430, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
          >
            <div className="ws-milestone-drawer-head">
              <span>Edit milestone</span>
              <span className="ws-document-state" data-dirty={saving}>
                {!saving && <Check aria-hidden="true" />}
                {saving ? "Saving…" : "Saved"}
              </span>
              <button
                type="button"
                className="ws-milestone-drawer-close"
                aria-label="Close editor"
                onClick={() => setEditorOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </div>

            <input
              className="ws-milestone-drawer-title"
              value={title}
              readOnly={readOnly}
              aria-label="Milestone title"
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                const next = title.trim();
                if (next && next !== selected.title) void save({ title: next });
              }}
            />

            <div className="ws-milestone-field ws-milestone-field-date">
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
              <small>{fullDate(dueDate || null)}</small>
            </div>

            <div className="ws-milestone-field">
              <span><Circle aria-hidden="true" />Status</span>
              <div className="ws-milestone-statuses">
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
            </div>

            <label className="ws-milestone-field ws-milestone-notes">
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

            <div className="ws-milestone-drawer-foot">
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
          </motion.aside>
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
        }}
        onConfirm={addMilestone}
      />
    </div>
  );
}
