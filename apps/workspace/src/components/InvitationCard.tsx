import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";

import type { Invite } from "../lib/types";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { when } from "./when";

/** The same invitation and response states on Home and in the inbox. */
export function InvitationCard({
  invite,
  onOpenProject,
}: {
  invite: Invite;
  onOpenProject: (id: string) => void;
}) {
  const accept = useWorkspaceStore((state) => state.acceptInvite);
  const decline = useWorkspaceStore((state) => state.declineInvite);
  const [responding, setResponding] = useState<"accept" | "decline" | null>(
    null,
  );
  const name = invite.projectName || "Shared project";
  const sender = invite.inviterName || invite.inviterEmail;

  async function respond(action: "accept" | "decline") {
    if (responding) return;
    setResponding(action);
    try {
      if (action === "decline") await decline(invite.id);
      else {
        await accept(invite.id);
        const current = useWorkspaceStore.getState();
        if (
          !current.invites.some((item) => item.id === invite.id) &&
          current.projects.some((project) => project.id === invite.projectId)
        )
          onOpenProject(invite.projectId);
      }
    } finally {
      setResponding(null);
    }
  }

  return (
    <article className="ws-invitation" aria-label={`Invitation to ${name}`}>
      <span
        className="ws-project-badge ws-invitation-avatar"
        aria-hidden="true"
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <div className="ws-invitation-copy">
        <div className="ws-invitation-title">
          <h3>{name}</h3>
          <span className="ws-pill">{invite.role}</span>
        </div>
        <p>
          {sender ? `${sender} invited you` : "You’ve been invited to join"} ·{" "}
          {when(invite.createdAt)}
        </p>
      </div>
      <div className="ws-invitation-actions">
        <button
          className="btn btn-ghost"
          disabled={responding !== null}
          aria-label={`Decline invitation to ${name}`}
          aria-busy={responding === "decline"}
          onClick={() => void respond("decline")}
        >
          {responding === "decline" ? "Declining…" : "Decline"}
        </button>
        <button
          className="btn btn-primary"
          disabled={responding !== null}
          aria-label={`Accept invitation to ${name}`}
          aria-busy={responding === "accept"}
          onClick={() => void respond("accept")}
        >
          {responding === "accept" ? (
            <>
              <Check /> Joining…
            </>
          ) : (
            <>
              Accept invitation <ArrowRight />
            </>
          )}
        </button>
      </div>
    </article>
  );
}
