/**
 * The greeting a Hook home screen shows.
 *
 * One catalog for every product: the chat window's hero, the dock Hook
 * Workspace and Hook Browser embed, the phone, and (through a generated copy)
 * Hook Browser's new tab page. Copy lives here and nowhere else.
 *
 * Three rules are deliberate:
 *
 *  1. The draw is per session, not per render. A re-render, leaving a chat and
 *     coming back, or the app going to the background for a minute must not
 *     change the line. A new time window must.
 *  2. Each window keeps its own shuffled queue, so all twelve lines of that
 *     window appear before any repeats. The queue is per device and survives a
 *     restart in `localStorage`; a reshuffle never starts on the line that was
 *     just shown.
 *  3. Only two entries take the account holder's first name, and they take it
 *     by identity: the named form is a rendering of the same entry, so it is
 *     still one draw.
 */

export type GreetingWindow =
  | "early"
  | "morning"
  | "midday"
  | "afternoon"
  | "evening"
  | "night";

export interface GreetingEntry {
  /** Stable identity: the rotation stores this, and the named form is a
      property of the entry rather than a match on its text. */
  id: string;
  text: string;
  /** The same entry with a first name; `{name}` is replaced. Only the two
      entries allowed to use a name define this. */
  named?: string;
}

/** The catalog, by time window. Order is the order a fresh shuffle draws from. */
/**
 * One window's entries. A non-empty tuple, not an array: every window has at
 * least one greeting, and saying so in the type is what lets `entries[0]` mean a
 * greeting rather than `GreetingEntry | undefined` under
 * `noUncheckedIndexedAccess` — which Chromium's WebUI build turns on, and this
 * file is copied into it verbatim.
 */
type GreetingCatalog = readonly [GreetingEntry, ...GreetingEntry[]];

export const GREETINGS: Record<GreetingWindow, GreetingCatalog> = {
  early: [
    { id: "early-early-bird", text: "Morning, early bird." },
    {
      id: "good-morning",
      text: "Good morning.",
      named: "Good morning, {name}",
    },
    { id: "early-beat-the-alarm", text: "Beat the alarm?" },
    { id: "early-up-already", text: "Up already?" },
    { id: "early-birds", text: "Just us and the birds." },
    { id: "early-riser", text: "Hey there, early riser." },
    { id: "early-quiet", text: "Quiet morning, huh?" },
    { id: "early-first-light", text: "First light, first thought." },
    { id: "early-before-world", text: "Before the world wakes up." },
    { id: "early-first-cup", text: "First cup?" },
    { id: "early-coffee-asleep", text: "Even the coffee’s asleep." },
    { id: "early-starting-early", text: "Starting early today?" },
  ],
  morning: [
    { id: "morning-coffee-hook", text: "Coffee and Hook?" },
    { id: "morning-hey", text: "Morning!" },
    { id: "morning-first", text: "What’s first today?" },
    { id: "morning-brewing", text: "What’s brewing?" },
    { id: "morning-coffee-hand", text: "Coffee in hand?" },
    {
      id: "morning-mind",
      text: "What’s on your mind this morning?",
    },
    { id: "morning-ready", text: "Ready when you are." },
    { id: "morning-bright-ideas", text: "Any bright ideas?" },
    { id: "morning-start", text: "Let’s get started." },
    {
      id: "morning-fresh-start",
      text: "Nice morning for a fresh start.",
    },
    { id: "morning-where", text: "Where should we start?" },
    { id: "morning-up-running", text: "Look who’s up and running." },
  ],
  midday: [
    { id: "midday-good-afternoon", text: "Good afternoon." },
    { id: "midday-food-for-thought", text: "A little food for thought?" },
    { id: "midday-lunch-idea", text: "Lunch break idea?" },
    { id: "midday-how-day", text: "Hey, how’s your day going?" },
    { id: "midday-minute", text: "Got a minute?" },
    { id: "midday-menu", text: "What’s on the menu?" },
    {
      id: "midday-half-day",
      text: "Half a day, plenty of ideas.",
    },
    { id: "midday-detour", text: "A quick lunchtime detour?" },
    { id: "midday-next", text: "What’s next today?" },
    { id: "midday-lunch-crew", text: "Hey there, lunch crew." },
    { id: "midday-sandwich", text: "Sandwich in one hand?" },
    { id: "midday-chair", text: "Pull up a chair." },
  ],
  afternoon: [
    { id: "afternoon-good-afternoon", text: "Good afternoon." },
    { id: "afternoon-coffee", text: "One more coffee?" },
    {
      id: "afternoon-treating",
      text: "How’s the afternoon treating you?",
    },
    { id: "afternoon-second-wind", text: "Got a second wind?" },
    { id: "afternoon-breather", text: "Time for a breather?" },
    { id: "afternoon-snack", text: "Is it snack o’clock?" },
    { id: "afternoon-list", text: "What’s next on your list?" },
    { id: "afternoon-pace", text: "A quick change of pace?" },
    { id: "afternoon-brainwave", text: "Afternoon brainwave?" },
    { id: "afternoon-got", text: "What have you got for me?" },
    { id: "afternoon-coffee-company", text: "Coffee break company?" },
    { id: "afternoon-where", text: "Where were we?" },
  ],
  evening: [
    {
      id: "good-evening",
      text: "Good evening.",
      named: "Good evening, {name}",
    },
    { id: "evening-after-hours", text: "Hook after hours." },
    { id: "evening-how-was-day", text: "How was your day?" },
    { id: "evening-side-quest", text: "A little side quest?" },
    { id: "evening-hey", text: "Hey, how’s your evening?" },
    {
      id: "evening-anything",
      text: "Anything on your mind tonight?",
    },
    { id: "evening-making", text: "What are we making tonight?" },
    { id: "evening-settling", text: "Settling in?" },
    {
      id: "evening-project",
      text: "Let’s call it an evening project.",
    },
    { id: "evening-quiet", text: "A quiet moment to think." },
    { id: "evening-dinner", text: "Got a minute before dinner?" },
    { id: "evening-one-more", text: "Room for one more idea?" },
  ],
  night: [
    { id: "night-still-up", text: "Still up?" },
    { id: "night-owl", text: "Hey, night owl." },
    { id: "night-late-idea", text: "Late-night idea?" },
    { id: "night-last-idea", text: "Okay, one last idea." },
    { id: "night-quiet", text: "Quiet out there, huh?" },
    { id: "night-couldnt-sleep", text: "Couldn’t sleep either?" },
    { id: "night-mind", text: "What’s on your mind tonight?" },
    { id: "night-shift", text: "Ah, the night shift." },
    { id: "night-city", text: "The city’s on mute." },
    { id: "night-catch", text: "Catch that thought." },
    {
      id: "night-odd-hours",
      text: "The good ideas have odd hours.",
    },
    { id: "night-tomorrow", text: "Tomorrow can wait a minute." },
  ],
};

/** The six windows in the order of a day, starting at 05:00. */
export const GREETING_WINDOWS: readonly GreetingWindow[] = [
  "early",
  "morning",
  "midday",
  "afternoon",
  "evening",
  "night",
];

export const GREETING_STORAGE_KEY = "hook.greetings.v1";

interface WindowRotation {
  /** The ids this shuffle still owes, in draw order. */
  queue: string[];
  /** The id drawn last, so a reshuffle never repeats it immediately. */
  last: string | null;
}

interface GreetingState {
  version: 1;
  windows: Partial<Record<GreetingWindow, WindowRotation>>;
}

/** What is on screen: one entry, kept until the window changes. */
let session: { window: GreetingWindow; entry: GreetingEntry } | null = null;

/**
 * The window an hour of the local day belongs to.
 *
 * The night window wraps: 23:00 through 04:59, midnight included. `hour` is
 * `Date#getHours()`, 0–23.
 */
export function greetingWindow(hour: number): GreetingWindow {
  if (hour >= 5 && hour < 8) return "early";
  if (hour >= 8 && hour < 12) return "morning";
  if (hour >= 12 && hour < 15) return "midday";
  if (hour >= 15 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

/**
 * The greeting to show, rendered with the account holder's first name where
 * the entry allows it.
 *
 * `now` exists so a boundary can be tested; products call it with no arguments
 * and get the device's local clock.
 */
export function greeting(
  firstName?: string | null,
  now: Date = new Date(),
): string {
  const current = greetingWindow(now.getHours());
  // A re-render, a closed chat or a minute in another app keeps this entry; a
  // different window draws from that window's own rotation.
  if (session?.window !== current) {
    session = { window: current, entry: drawGreeting(current) };
  }
  return renderGreeting(session.entry, firstName);
}

/**
 * The next entry of a window's rotation, advancing and persisting it.
 *
 * Exported because it is the half with no session state: a test walks a whole
 * shuffle through it, and `greeting` is the only product entry point.
 */
export function drawGreeting(window: GreetingWindow): GreetingEntry {
  const entries = GREETINGS[window];
  const state = readState();
  const rotation = state.windows[window] ?? { queue: [], last: null };
  if (rotation.queue.length === 0) {
    rotation.queue = shuffled(
      entries.map((entry) => entry.id),
      rotation.last,
    );
  }
  const id = rotation.queue.shift() ?? entries[0].id;
  rotation.last = id;
  state.windows[window] = rotation;
  writeState(state);
  return entries.find((entry) => entry.id === id) ?? entries[0];
}

/** An entry as it is written, or with the first name its `named` form allows. */
export function renderGreeting(
  entry: GreetingEntry,
  firstName?: string | null,
): string {
  // The account's display name is the source; the first word is the first name.
  // A blank or missing name keeps the base phrase, punctuation included.
  const name = firstName?.trim().split(/\s+/)[0] ?? "";
  if (!name || !entry.named) return entry.text;
  return entry.named.replace("{name}", () => name);
}

/** Forget both the on-screen entry and the stored rotation. For tests. */
export function resetGreetings(): void {
  session = null;
  try {
    storage()?.removeItem(GREETING_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Fisher–Yates, with the last draw kept out of the front of a new cycle. */
function shuffled(ids: readonly string[], avoidFirst: string | null): string[] {
  const next = [...ids];
  // The two `undefined` guards are unreachable — both indexes are in range — and
  // they are here because this file also compiles with `noUncheckedIndexedAccess`
  // inside Chromium's WebUI build, where an indexed read is a Maybe.
  const swap = (a: number, b: number): void => {
    const held = next[a];
    const other = next[b];
    if (held === undefined || other === undefined) return;
    next[a] = other;
    next[b] = held;
  };
  for (let i = next.length - 1; i > 0; i -= 1) {
    swap(i, Math.floor(Math.random() * (i + 1)));
  }
  if (next.length > 1 && next[0] === avoidFirst) {
    swap(0, 1 + Math.floor(Math.random() * (next.length - 1)));
  }
  return next;
}

/** `localStorage`, or null where the WebView does not offer one. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // A WebView with storage disabled throws on the property itself.
    return null;
  }
}

function readState(): GreetingState {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(GREETING_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  return normalize(raw);
}

function writeState(state: GreetingState): void {
  try {
    storage()?.setItem(GREETING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The rotation only needs to survive where the device allows it.
  }
}

/**
 * A stored state, repaired. A catalog edit retires ids that no longer exist
 * rather than letting them poison a queue, and one bad row does not lose the
 * other windows.
 */
function normalize(raw: string | null): GreetingState {
  const empty: GreetingState = { version: 1, windows: {} };
  if (!raw) return empty;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return empty;
  }
  const windows = (value as { windows?: unknown } | null)?.windows;
  if (!windows || typeof windows !== "object") return empty;

  const state: GreetingState = { version: 1, windows: {} };
  for (const window of GREETING_WINDOWS) {
    const slot = (windows as Record<string, unknown>)[window];
    if (!slot || typeof slot !== "object") continue;
    const known = new Set(GREETINGS[window].map((entry) => entry.id));
    const rawQueue = (slot as { queue?: unknown }).queue;
    const queue = Array.isArray(rawQueue)
      ? [
          ...new Set(
            rawQueue.filter(
              (id): id is string => typeof id === "string" && known.has(id),
            ),
          ),
        ]
      : [];
    const rawLast = (slot as { last?: unknown }).last;
    const last =
      typeof rawLast === "string" && known.has(rawLast) ? rawLast : null;
    state.windows[window] = { queue, last };
  }
  return state;
}
