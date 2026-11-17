import type { Member } from "./types";

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
 * A task can point at someone who is not in the project (they left, or the
 * agent wrote an address). Show the address when it is one; show nothing
 * human-unreadable when it is a bare subject.
 */
export function unknownPerson(value: string): string {
  return /^\d{5,}$/.test(value) ? "Someone not in this project" : `${value} (not in this project)`;
}
