import {
  ArrowRight,
  ArrowUpRight,
  FileText,
  KanbanSquare,
  MailOpen,
  Plus,
  Users,
} from "lucide-react";
import { HookMark } from "@hook/ui";

import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { InvitationCard } from "./InvitationCard";
import { when } from "./when";

export function WorkspaceHome({
  onNewProject,
  onAskHook,
  onOpenProject,
  onOpenInvites,
}: {
  onNewProject: () => void;
  onAskHook: () => void;
  onOpenProject: (id: string) => void;
  onOpenInvites: () => void;
}) {
  const ready = useWorkspaceStore((state) => state.ready);
  const projects = useWorkspaceStore((state) => state.projects);
  const invites = useWorkspaceStore((state) => state.invites);
  const pending = invites.filter((invite) => invite.status === "pending");
  const recent = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="ws-home" aria-busy={!ready}>
      <header className="ws-home-heading">
        <h1>What are we working on?</h1>
        <p>
          A little structure for your ideas. A shared place to make them happen.
        </p>
      </header>

      {!ready ? (
        <p className="ws-home-loading" role="status">
          Loading your workspace…
        </p>
      ) : (
        <>
          {pending.length > 0 && (
            <section
              className="ws-home-invitations"
              aria-labelledby="home-invitations-title"
            >
              <header className="ws-home-section-head">
                <span className="ws-home-invite-icon" aria-hidden="true">
                  <MailOpen />
                </span>
                <div>
                  <h2 id="home-invitations-title">
                    {pending.length === 1
                      ? "You have an invitation"
                      : `You have ${pending.length} invitations`}
                  </h2>
                  <p>There’s a place for you on the team.</p>
                </div>
                {pending.length > 3 && (
                  <button className="btn btn-ghost" onClick={onOpenInvites}>
                    View all <ArrowRight />
                  </button>
                )}
              </header>
              <div className="ws-invitation-list">
                {pending.slice(0, 3).map((invite) => (
                  <InvitationCard
                    key={invite.id}
                    invite={invite}
                    onOpenProject={onOpenProject}
                  />
                ))}
              </div>
            </section>
          )}

          {recent.length > 0 && (
            <section
              className="ws-home-projects"
              aria-labelledby="home-projects-title"
            >
              <header className="ws-home-section-head">
                <h2 id="home-projects-title">
                  Your projects <span>{projects.length}</span>
                </h2>
                <button className="btn btn-ghost" onClick={onNewProject}>
                  <Plus /> New project
                </button>
              </header>
              <div className="ws-home-project-list">
                {recent.map((project) => (
                  <button
                    className="ws-home-project"
                    key={project.id}
                    onClick={() => onOpenProject(project.id)}
                  >
                    <span className="ws-project-badge" aria-hidden="true">
                      {project.name.trim().charAt(0).toUpperCase() || "H"}
                    </span>
                    <span className="ws-home-project-copy">
                      <strong>{project.name}</strong>
                      <span>
                        {project.description ||
                          `Updated ${when(project.updatedAt)}`}
                      </span>
                    </span>
                    <span className="ws-pill">{project.role}</span>
                    <ArrowUpRight
                      className="ws-home-project-arrow"
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="ws-home-start">
            <section className="ws-home-create">
              <div className="ws-home-create-icon" aria-hidden="true">
                <Plus />
              </div>
              <h2>
                {projects.length
                  ? "Make room for another idea."
                  : "It starts with a project."}
              </h2>
              <p>
                Bring the work, the thinking, and the right people together in
                one place.
              </p>
              <div
                className="ws-home-tools"
                aria-label="What a project includes"
              >
                <span>
                  <KanbanSquare /> Boards
                </span>
                <span>
                  <FileText /> Documents
                </span>
                <span>
                  <Users /> People
                </span>
              </div>
              <button className="btn btn-primary" onClick={onNewProject}>
                Create a project <ArrowRight />
              </button>
            </section>
            <section className="ws-home-hook">
              <HookMark className="ws-home-hook-mark" />
              <h2>An idea is a good start.</h2>
              <p>
                Talk it through with Hook. Turn a rough thought into a plan you
                can work with.
              </p>
              <button className="btn btn-ghost" onClick={onAskHook}>
                Plan with Hook <ArrowUpRight />
              </button>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
