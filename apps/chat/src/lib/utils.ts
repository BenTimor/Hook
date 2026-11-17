import type { ChatMeta } from "./types";

export function sortMetas(list: ChatMeta[]): ChatMeta[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    return b.updatedAt - a.updatedAt;
  });
}

export function upsertMeta(list: ChatMeta[], meta: ChatMeta): ChatMeta[] {
  const next = list.some((c) => c.id === meta.id)
    ? list.map((c) => (c.id === meta.id ? meta : c))
    : [meta, ...list];
  return sortMetas(next);
}

export type Bucket = { label: string; chats: ChatMeta[] };

const DAY = 86_400_000;

export function groupChats(chats: ChatMeta[]): Bucket[] {
  const pinned = chats.filter((c) => c.pinned);
  const rest = chats.filter((c) => !c.pinned);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();

  const buckets: Bucket[] = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "Previous 7 days", chats: [] },
    { label: "Previous 30 days", chats: [] },
    { label: "Older", chats: [] },
  ];

  for (const chat of rest) {
    const t = chat.updatedAt;
    if (t >= today) buckets[0].chats.push(chat);
    else if (t >= today - DAY) buckets[1].chats.push(chat);
    else if (t >= today - 7 * DAY) buckets[2].chats.push(chat);
    else if (t >= today - 30 * DAY) buckets[3].chats.push(chat);
    else buckets[4].chats.push(chat);
  }

  const out: Bucket[] = [];
  if (pinned.length) out.push({ label: "Pinned", chats: pinned });
  for (const bucket of buckets) {
    if (bucket.chats.length) out.push(bucket);
  }
  return out;
}

export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** ⌘ on macOS, Ctrl elsewhere — used for shortcut hints in the UI. */
export const modKey = isMac ? "⌘" : "Ctrl+";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function isModKey(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}
