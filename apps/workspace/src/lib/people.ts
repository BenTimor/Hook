import type { Invite, Member, Task } from "./types";

/**
 * What to call a person.
 *
 * A subject is an account id — a long number — and never something to show: if
 * the profile has not arrived, say "Member" rather than a number that will
 * change the moment the feed catches up.
 */
export function personLabel(member: Member | undefined | null): string {
  if (!member) return "Member";
  return member.name || member.email || "Member";
}

/**
 * The member a task's assignee points at, or null.
 *
 * A task is assigned by account subject, but one written before an invitation
 * was accepted can still carry the address it was sent to. Matching the
 * address too means that task shows the person's name the moment they join,
 * even on a server that has not rewritten the row yet.
 */
export function personFor(
  members: Member[],
  value: string | null | undefined,
): Member | null {
  if (!value) return null;
  const direct = members.find((member) => member.subject === value);
  if (direct) return direct;
  const email = value.toLowerCase();
  return members.find((member) => member.email?.toLowerCase() === email) ?? null;
}

/**
 * Everyone assigned to a task.
 *
 * `assignees` is the list current servers and windows write; `assignee` keeps
 * a single-person task from before it existed readable.
 */
export function taskAssignees(
  task: Pick<Task, "assignee" | "assignees">,
): string[] {
  if (Array.isArray(task.assignees)) {
    return task.assignees.filter((value) => typeof value === "string" && value);
  }
  return task.assignee ? [task.assignee] : [];
}

/** The best readable label for one assignment value. */
export function assigneeLabel(members: Member[], value: string): string {
  const member = personFor(members, value);
  return member ? personLabel(member) : unknownPerson(value);
}

/**
 * Invitations still waiting for an answer and not yet matched by a member.
 *
 * Two windows can disagree for a few seconds — this one accepted, another has
 * not polled yet — so an address already belonging to a member is left out.
 */
export function pendingPeople(members: Member[], invites: Invite[]): Invite[] {
  const joined = new Set(
    members
      .map((member) => member.email?.toLowerCase())
      .filter((email): email is string => Boolean(email)),
  );
  return invites.filter(
    (invite) => invite.status === "pending" && !joined.has(invite.email.toLowerCase()),
  );
}

/**
 * A task can point at someone who is not in the project (they left, or the
 * agent wrote an address). An address is shown as it is — that is the handle a
 * pending invitation has, and reading it is the point. A bare subject is not.
 */
export function unknownPerson(value: string): string {
  if (value.includes("@")) return value;
  return /^\d{5,}$/.test(value) ? "Someone not in this project" : `${value} (not in this project)`;
}
