export type Shortcut = { kind: "board" | "document"; id: string };
type Shortcuts = { favorites: Shortcut[]; recent: Shortcut[] };

const key = (email: string, projectId: string) =>
  `hook.workspace.shortcuts.v1:${encodeURIComponent(email.toLowerCase())}:${encodeURIComponent(projectId)}`;

export function readShortcuts(
  email: string | null,
  projectId: string,
): Shortcuts {
  const empty: Shortcuts = { favorites: [], recent: [] };
  if (!email) return empty;
  try {
    const value = JSON.parse(
      localStorage.getItem(key(email, projectId)) || "null",
    );
    const valid = (items: unknown): Shortcut[] =>
      Array.isArray(items)
        ? items.filter(
            (item) =>
              item &&
              (item.kind === "board" || item.kind === "document") &&
              typeof item.id === "string",
          )
        : [];
    return { favorites: valid(value?.favorites), recent: valid(value?.recent) };
  } catch {
    return empty;
  }
}

export function writeShortcuts(
  email: string | null,
  projectId: string,
  value: Shortcuts,
) {
  if (!email) return;
  try {
    localStorage.setItem(key(email, projectId), JSON.stringify(value));
  } catch {
    /* Storage can be unavailable. */
  }
}

export function rememberOpened(
  email: string | null,
  projectId: string,
  item: Shortcut,
) {
  const current = readShortcuts(email, projectId);
  current.recent = [
    item,
    ...current.recent.filter(
      (entry) => entry.kind !== item.kind || entry.id !== item.id,
    ),
  ].slice(0, 12);
  writeShortcuts(email, projectId, current);
}
