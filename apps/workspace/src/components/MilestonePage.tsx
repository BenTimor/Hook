import { useEffect, useState } from "react";
import {
  AlignLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  Flag,
  Trash2,
} from "lucide-react";

import type { Milestone, MilestoneStatus, Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

const STATUS: Array<{ id: MilestoneStatus; label: string; Icon: typeof Circle }> = [
  { id: "planned", label: "Planned", Icon: Circle },
  { id: "active", label: "In progress", Icon: Clock3 },
  { id: "done", label: "Done", Icon: CheckCircle2 },
];

function formatDate(value: string | null): string {
  if (!value) return "No date yet";
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

/** A milestone is a full page; its fields sit in a horizontal, scrollable rail. */
export function MilestonePage({
  id,
  project,
  onBack,
}: {
  id: string;
  project: Project;
  onBack: () => void;
}) {
  const loadMilestone = useWorkspaceStore((state) => state.loadMilestone);
  const updateMilestone = useWorkspaceStore((state) => state.updateMilestone);
  const deleteMilestone = useWorkspaceStore((state) => state.deleteMilestone);
  const stored = useWorkspaceStore((state) =>
    (state.milestones[project.id] ?? []).find((milestone) => milestone.id === id),
  );

  const [loaded, setLoaded] = useState<Milestone | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<MilestoneStatus>("planned");
  const [saving, setSaving] = useState(false);
  const readOnly = project.role === "viewer";

  useEffect(() => {
    let alive = true;
    void loadMilestone(id).then((milestone) => {
      if (!alive || !milestone) return;
      setLoaded(milestone);
      setTitle(milestone.title);
      setDescription(milestone.description);
      setDueDate(milestone.dueDate ?? "");
      setStatus(milestone.status);
    });
    return () => {
      alive = false;
    };
  }, [id, loadMilestone]);

  useEffect(() => {
    if (!stored) return;
    setDueDate((current) =>
      current === (stored.dueDate ?? "") ? current : stored.dueDate ?? "",
    );
    setStatus((current) => (current === stored.status ? current : stored.status));
  }, [stored?.dueDate, stored?.status]);

  if (!loaded) {
    return <section className="ws-empty">Opening…</section>;
  }

  const save = async (patch: Partial<Milestone>) => {
    setSaving(true);
    const saved = await updateMilestone(id, patch);
    setSaving(false);
    if (!saved) return;
    setLoaded((current) => (current ? { ...current, ...patch } : current));
  };

  return (
    <div className="ws-milestone">
      <div className="ws-milestone-bar">
        <input
          className="ws-milestone-title"
          value={title}
          readOnly={readOnly}
          aria-label="Milestone title"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            const next = title.trim();
            if (next && next !== loaded.title) void save({ title: next });
          }}
        />
        <span className="ws-document-state" data-dirty={saving}>
          {!saving && <Check aria-hidden="true" />}
          {saving ? "Saving…" : "Saved"}
        </span>
        {!readOnly ? (
          <button
            type="button"
            className="ws-milestone-delete"
            aria-label="Delete milestone"
            title="Delete milestone"
            onClick={() => {
              if (confirm("Delete this milestone for everyone?")) {
                void deleteMilestone(id).then(onBack);
              }
            }}
          >
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="ws-milestone-canvas">
        <div className="ws-milestone-track" aria-label="Milestone details">
          <section className="ws-milestone-card ws-milestone-date">
            <header>
              <CalendarDays aria-hidden="true" />
              <span>Target date</span>
            </header>
            <input
              type="date"
              lang="en-GB"
              value={dueDate}
              readOnly={readOnly}
              aria-label="Target date"
              onChange={(event) => {
                const next = event.target.value;
                setDueDate(next);
                void save({ dueDate: next || null });
              }}
            />
            <small>{formatDate(dueDate || null)}</small>
          </section>

          <section className="ws-milestone-card">
            <header>
              <Flag aria-hidden="true" />
              <span>Status</span>
            </header>
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
          </section>

          <section className="ws-milestone-card ws-milestone-notes">
            <header>
              <AlignLeft aria-hidden="true" />
              <span>Description</span>
            </header>
            <textarea
              value={description}
              readOnly={readOnly}
              aria-label="Milestone description"
              placeholder="What does this milestone mean?"
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => {
                if (description !== loaded.description) void save({ description });
              }}
            />
          </section>

          <section className="ws-milestone-card ws-milestone-meta">
            <header>
              <Flag aria-hidden="true" />
              <span>About</span>
            </header>
            <dl>
              <div><dt>Project</dt><dd>{project.name}</dd></div>
              <div><dt>Updated</dt><dd>{new Date(loaded.updatedAt).toLocaleDateString("en-GB")}</dd></div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
