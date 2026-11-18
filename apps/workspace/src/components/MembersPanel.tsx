import { useState } from "react";
import { Mail, UserPlus } from "lucide-react";

import { Dialog } from "@hook/ui";

import type { Project, Role } from "../lib/types";
import { personLabel } from "../lib/people";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { InvitationCard } from "./InvitationCard";

const EMPTY: never[] = [];

const ROLES: Array<{ id: Role; label: string; note: string }> = [
  { id: "viewer", label: "Viewer", note: "Can read everything, change nothing." },
  { id: "editor", label: "Editor", note: "Creates and edits boards, tasks and documents." },
  { id: "manager", label: "Manager", note: "Editor, plus inviting viewers and editors." },
];

/**
 * People, roles and the one irreversible action.
 *
 * What the UI offers is narrower than what the server allows, on purpose: a
 * manager is shown no manager option, and only the owner sees the transfer.
 * The server is still the authority — this is courtesy, not security.
 */
export function MembersPanel({ project }: { project: Project }) {
  const members = useWorkspaceStore((state) => state.members[project.id] ?? EMPTY);
  const invite = useWorkspaceStore((state) => state.invite);
  const changeRole = useWorkspaceStore((state) => state.setRole);
  const removeMember = useWorkspaceStore((state) => state.removeMember);
  const transferOwnership = useWorkspaceStore((state) => state.transferOwnership);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<Role, "owner">>("editor");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<string | null>(null);

  const isOwner = project.role === "owner";
  const isManager = isOwner || project.role === "manager";
  const managers = members.filter((member) => member.role === "manager");

  /** What this viewer may hand out, per the server's rules. */
  const grantable = isOwner
    ? ROLES
    : ROLES.filter((entry) => entry.id !== "manager");

  return (
    <div className="ws-people">
      <div className="ws-people-head">
        <span>{members.length} in this project</span>
        {isManager && (
          <button className="btn" onClick={() => setInviteOpen(true)}>
            <UserPlus /> Invite someone
          </button>
        )}
      </div>

      <ul className="ws-people-list">
        {members.map((member) => {
          // The API does not expose "who am I"; the owner row is the only
          // one we can label with confidence.
          const isMe = Boolean(project.mine) && member.role === "owner";
          const label = personLabel(member);
          const canChange =
            !isMe &&
            member.role !== "owner" &&
            isManager &&
            (isOwner || member.role !== "manager");
          return (
            <li className="ws-person" key={member.subject}>
              <div className="ws-person-who">
                <span className="ws-avatar" aria-hidden="true">
                  {label.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <div className="ws-person-name">
                    {label}
                    {isMe ? <span className="ws-you">you</span> : null}
                  </div>
                  {member.email && member.name ? (
                    <div className="ws-person-email">{member.email}</div>
                  ) : null}
                </div>
              </div>

              <div className="ws-person-actions">
                {canChange ? (
                  <select
                    className="text-input ws-role"
                    value={member.role}
                    onChange={(event) =>
                      void changeRole(project.id, member.subject, event.target.value)
                    }
                  >
                    {grantable.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="ws-role-static">
                    {member.role === "owner" ? "Owner" : capitalize(member.role)}
                  </span>
                )}
                {isOwner && member.role === "manager" && !isMe && (
                  <button className="btn btn-ghost" onClick={() => setTransfer(member.subject)}>
                    Make owner
                  </button>
                )}
                {canChange && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setRemoving(member.subject)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={inviteOpen}
        title="Invite someone"
        description="They accept it in Hook Workspace. Until then they see no boards or documents."
        onClose={() => setInviteOpen(false)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setInviteOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!email.trim()}
              onClick={() => {
                void invite(project.id, email.trim(), role);
                setEmail("");
                setRole("editor");
                setInviteOpen(false);
              }}
            >
              Send invitation
            </button>
          </>
        }
      >
        <label className="dlg-field">
          <span>Email address</span>
          <input
            className="text-input"
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <div className="ws-role-choices">
          {grantable.map((entry) => (
            <label key={entry.id} className="ws-role-choice" data-active={role === entry.id}>
              <input
                type="radio"
                name="role"
                checked={role === entry.id}
                onChange={() => setRole(entry.id as Exclude<Role, "owner">)}
              />
              <div>
                <span>{entry.label}</span>
                <p>{entry.note}</p>
              </div>
            </label>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={removing !== null}
        title="Remove this person?"
        description="They lose access to everything in this project immediately. You can invite them again later."
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRemoving(null)}>
              Keep access
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (removing) void removeMember(project.id, removing);
                setRemoving(null);
              }}
            >
              Remove
            </button>
          </>
        }
      />

      <Dialog
        open={transfer !== null}
        title="Give this project to someone else?"
        description="Ownership is permanent and cannot be undone. You become a manager; they can then delete the project or pass it on."
        onClose={() => setTransfer(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setTransfer(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!transfer || !isOwner}
              onClick={() => {
                if (transfer) void transferOwnership(project.id, transfer);
                setTransfer(null);
              }}
            >
              Transfer ownership
            </button>
          </>
        }
      >
        <p className="ws-warning">
          Only a manager who already accepted the invitation can own the project.
          {managers.length === 0
            ? " There is no manager yet: make one above first."
            : ""}
        </p>
        <ul className="ws-people-list">
          {managers.map((manager) => (
            <li className="ws-person" key={manager.subject}>
              <span>{manager.name || manager.email || manager.subject}</span>
              <button
                className="btn"
                data-active={transfer === manager.subject}
                onClick={() => setTransfer(manager.subject)}
              >
                {transfer === manager.subject ? "Selected" : "Choose"}
              </button>
            </li>
          ))}
        </ul>
        {!isOwner && (
          <p className="ws-warning">Only the owner can transfer a project.</p>
        )}
      </Dialog>
    </div>
  );
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

/** The inbox: invitations addressed to this account. */
export function InvitesPanel({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const invites = useWorkspaceStore((state) => state.invites);
  const pending = invites.filter((invite) => invite.status === "pending");

  if (pending.length === 0) {
    return (
      <section className="ws-empty">
        <Mail className="ws-empty-icon" />
        <h2>No invitations</h2>
        <p>When someone invites you to a project, it appears here.</p>
      </section>
    );
  }

  return (
    <div className="ws-home ws-inbox">
      <header className="ws-home-heading">
        <h1>Your invitations</h1>
        <p>Join a project and make something happen together.</p>
      </header>
      <div className="ws-invitation-list">
        {pending.map((invite) => <InvitationCard key={invite.id} invite={invite} onOpenProject={onOpenProject} />)}
      </div>
    </div>
  );
}
