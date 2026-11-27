import { useCallback, useEffect, useState } from "react";
import { ChevronRight, RefreshCw, X } from "lucide-react";

import { WorkspacePreview, type WorkspaceTask } from "@hook/chat";

import { mobile } from "../lib/api";
import { BACK_LAYER, useBackHandler } from "../lib/back";

interface Project {
  id: string;
  name: string;
}

interface Column {
  id: string;
  name: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

interface Board {
  id: string;
  projectId: string;
  name: string;
  columns?: Column[];
}

interface Task extends WorkspaceTask {
  projectName: string;
  boardName: string;
  statusLabel: string;
}

const statusLabel = (board: Board, status: string) => {
  const column = board.columns?.find((entry) => entry.type === "status");
  return column?.options?.find((option) => option.id === status)?.label ?? status;
};

/**
 * The phone's Workspace destination.
 *
 * There is no separate Workspace application on a phone, but the account data
 * is already reachable through the same `ws_request` command the desktop
 * Workspace window uses. This screen reads the projects, boards and tasks and
 * draws the real task list; it does not invent cards and it does not write.
 */
export function WorkspaceTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);

  useBackHandler(BACK_LAYER.sheet, Boolean(selected), () => setSelected(null));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const projectsResult = (await mobile.wsRequest("GET", "/projects")) as {
        projects?: Project[];
      };
      const projects = projectsResult.projects ?? [];
      const collected: Task[] = [];

      await Promise.all(
        projects.map(async (project) => {
          try {
            const boardsResult = (await mobile.wsRequest(
              "GET",
              `/projects/${project.id}/boards`,
            )) as { boards?: Board[] };
            const boards = boardsResult.boards ?? [];
            await Promise.all(
              boards.map(async (board) => {
                try {
                  const tasksResult = (await mobile.wsRequest(
                    "GET",
                    `/boards/${board.id}/tasks`,
                  )) as { tasks?: WorkspaceTask[] };
                  for (const task of tasksResult.tasks ?? []) {
                    collected.push({
                      ...task,
                      projectName: project.name,
                      boardName: board.name,
                      statusLabel: statusLabel(board, task.status),
                    });
                  }
                } catch {
                  // One board that cannot be read must not empty the screen.
                }
              }),
            );
          } catch {
            // One project that cannot be read must not empty the screen.
          }
        }),
      );

      collected.sort((a, b) => b.updatedAt - a.updatedAt);
      setTasks(collected);
    } catch (caught) {
      setError(
        typeof caught === "string"
          ? caught
          : caught instanceof Error
            ? caught.message
            : "Could not load your tasks.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="screen workspace" aria-label="Workspace tasks">
      <div className="workspace-scroll">
        <header className="workspace-heading">
          <h1>Your tasks</h1>
          <p>Everything across your Hook Workspace projects.</p>
        </header>

        {loading ? (
          <div className="workspace-loading" role="status">
            <span className="workspace-spinner" aria-hidden="true" />
            Loading tasks…
          </div>
        ) : error ? (
          <div className="workspace-empty">
            <strong>Could not load your tasks.</strong>
            <p>{error}</p>
            <button className="btn" onClick={() => void load()}>
              <RefreshCw strokeWidth={1.8} />
              Try again
            </button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="workspace-empty">
            <strong>No tasks yet</strong>
            <p>Tasks in your Workspace projects will appear here.</p>
          </div>
        ) : (
          <div className="workspace-tasks">
            {tasks.map((task) => (
              <button
                className="workspace-task"
                key={task.id}
                onClick={() => setSelected(task)}
              >
                <span className="workspace-task-status">{task.statusLabel}</span>
                <span className="workspace-task-copy">
                  <strong>{task.title}</strong>
                  <em>
                    {task.projectName} · {task.boardName}
                  </em>
                </span>
                <ChevronRight strokeWidth={1.9} />
              </button>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <div className="sheet-backdrop" onMouseDown={() => setSelected(null)}>
          <div
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={selected.title}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheet-grip" aria-hidden="true" />
            <header className="sheet-head">
              <div className="sheet-heading">
                <div className="sheet-title">{selected.title}</div>
                <div className="sheet-note">
                  {selected.projectName} · {selected.boardName}
                </div>
              </div>
              <button
                className="icon-btn"
                title="Close"
                aria-label="Close"
                onClick={() => setSelected(null)}
              >
                <X strokeWidth={2} />
              </button>
            </header>
            <div className="sheet-body">
              <WorkspacePreview body={{ kind: "task", task: selected }} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
