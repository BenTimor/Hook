import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, Lightbulb, Plus, X } from "lucide-react";

import type { BrainstormIdea, Project } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

const EMPTY: never[] = [];

const CENTER = { x: 500, y: 350 };
const VIEW = { width: 1000, height: 700 };
const FIRST_RING = 6;

function ringFor(index: number) {
  let ring = 1;
  let start = 0;
  let size = FIRST_RING;
  while (index >= start + size) {
    start += size;
    size += 6;
    ring += 1;
  }
  return { ring, offset: index - start, size };
}

/**
 * A brainstorm: one word in the middle and ideas around it.
 *
 * The map is laid out from the order the ideas arrived in, not from a stored
 * coordinate, so two people looking at the same brainstorm see the same shape
 * and a new idea never lands on top of an old one.
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

  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!brainstorm) void loadBrainstorm(id);
  }, [brainstorm, id, loadBrainstorm]);

  const nodes = useMemo(
    () =>
      ideas
        .filter((idea) => idea.brainstormId === id)
        .map((idea, index, list) => {
          const { ring, offset, size } = ringFor(index);
          const angle = (offset / size) * Math.PI * 2 - Math.PI / 2 + ring * 0.35;
          const radius = Math.min(190 + (ring - 1) * 120, 320);
          return {
            idea,
            index,
            total: list.length,
            x: CENTER.x + Math.cos(angle) * radius,
            y: CENTER.y + Math.sin(angle) * radius,
          };
        }),
    [ideas, id],
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

  return (
    <div className="ws-page ws-brainstorm">
      <header className="ws-page-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back to project">
          <ArrowLeft />
        </button>
        <div className="ws-page-title">
          <h1>{brainstorm?.name || "Brainstorm"}</h1>
          <span>
            {nodes.length} {nodes.length === 1 ? "idea" : "ideas"}
          </span>
        </div>
      </header>

      <div className="ws-brainstorm-body">
        <div className="ws-brainstorm-map">
          <svg
            className="ws-brainstorm-links"
            viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {nodes.map(({ idea, x, y }) => (
              <line
                key={idea.id}
                x1={CENTER.x}
                y1={CENTER.y}
                x2={x}
                y2={y}
              />
            ))}
          </svg>

          <div
            className="ws-brainstorm-center"
            style={{
              left: `${(CENTER.x / VIEW.width) * 100}%`,
              top: `${(CENTER.y / VIEW.height) * 100}%`,
            }}
          >
            <Lightbulb aria-hidden="true" />
            <span>{brainstorm?.name || "Untitled"}</span>
          </div>

          {nodes.map(({ idea, x, y }) => (
            <div
              className="ws-brainstorm-node"
              key={idea.id}
              style={{
                left: `${(x / VIEW.width) * 100}%`,
                top: `${(y / VIEW.height) * 100}%`,
              }}
            >
              <span>{idea.text}</span>
              {canWrite && (
                <button
                  className="ws-brainstorm-node-remove"
                  aria-label="Remove idea"
                  title="Remove idea"
                  onClick={() => removeIdea(idea)}
                >
                  <X />
                </button>
              )}
            </div>
          ))}

          {nodes.length === 0 && (
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
