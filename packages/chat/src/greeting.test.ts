import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  GREETINGS,
  GREETING_STORAGE_KEY,
  GREETING_WINDOWS,
  drawGreeting,
  greeting,
  greetingWindow,
  renderGreeting,
  resetGreetings,
  type GreetingWindow,
} from "./greeting.ts";

/**
 * The greeting rules, from the six boundaries to the rotation and the two
 * phrases allowed to use a first name.
 *
 * Node has no `localStorage`, so the file installs an in-memory one. The
 * module reads it at call time, which is also what lets the "new session" test
 * import a fresh copy of the module and still find the rotation it left.
 */

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const store = memoryStorage();
const globals = globalThis as { localStorage?: Storage };

const all = GREETING_WINDOWS.flatMap((window) => GREETINGS[window]);
const textsOf = (window: GreetingWindow) =>
  new Set(GREETINGS[window].map((entry) => entry.text));
const at = (hour: number, minute = 0, day = 1) =>
  new Date(2026, 5, day, hour, minute);
const stored = () =>
  JSON.parse(store.getItem(GREETING_STORAGE_KEY) ?? "null") as {
    windows: Record<string, { queue: string[]; last: string | null }>;
  };

before(() => {
  Object.defineProperty(globals, "localStorage", {
    configurable: true,
    value: store,
    writable: true,
  });
});

after(() => {
  delete globals.localStorage;
});

beforeEach(() => {
  store.clear();
  resetGreetings();
});

test("every window carries twelve lines with unique ids", () => {
  for (const window of GREETING_WINDOWS) {
    const entries = GREETINGS[window];
    assert.equal(entries.length, 12, window);
    assert.equal(new Set(entries.map((entry) => entry.id)).size, 12, window);
  }
  assert.equal(new Set(all.map((entry) => entry.id)).size, 72);
});

test("the approved copy is stored as written", () => {
  const texts = new Set(all.map((entry) => entry.text));
  for (const phrase of [
    "Morning, early bird.",
    "Good morning.",
    "Morning!",
    "Good evening.",
    "Good afternoon.",
    "Still up?",
    "Even the coffee’s asleep.",
  ]) {
    assert.ok(texts.has(phrase), phrase);
  }
  assert.equal(
    GREETINGS.early.find((entry) => entry.id === "good-morning")?.text,
    "Good morning.",
  );
  assert.equal(
    GREETINGS.evening.find((entry) => entry.id === "good-evening")?.text,
    "Good evening.",
  );
});

test("six boundaries, and midnight stays in the night window", () => {
  const cases: Array<[number, number, GreetingWindow]> = [
    [4, 59, "night"],
    [5, 0, "early"],
    [7, 59, "early"],
    [8, 0, "morning"],
    [11, 59, "morning"],
    [12, 0, "midday"],
    [14, 59, "midday"],
    [15, 0, "afternoon"],
    [17, 59, "afternoon"],
    [18, 0, "evening"],
    [22, 59, "evening"],
    [23, 0, "night"],
  ];
  for (const [hour, minute, expected] of cases) {
    assert.equal(greetingWindow(at(hour, minute).getHours()), expected);
    // The draw itself must come from that window's list.
    resetGreetings();
    const line = greeting(null, at(hour, minute));
    assert.ok(
      textsOf(expected).has(line),
      `${hour}:${minute.toString().padStart(2, "0")} drew ${line}`,
    );
  }

  // 23:59 and 00:01 are the same window, so the session keeps its line.
  resetGreetings();
  const late = greeting(null, at(23, 59, 1));
  assert.ok(textsOf("night").has(late));
  assert.equal(greeting(null, at(0, 1, 2)), late);
});

test("a session reuses its line and a new window draws again", () => {
  resetGreetings();
  const first = greeting(null, at(11, 58));
  assert.ok(textsOf("morning").has(first));

  // A re-render, or leaving a chat and coming back, is the same session.
  assert.equal(greeting(null, at(11, 59)), first);
  // Only one draw was spent.
  assert.equal(stored().windows.morning.queue.length, 11);

  const midday = greeting(null, at(12, 5));
  assert.ok(textsOf("midday").has(midday));
  assert.notEqual(midday, first);
});

test("the rotation is persisted, so a new session continues it", async () => {
  resetGreetings();
  const first = greeting(null, at(9, 0));
  assert.ok(textsOf("morning").has(first));

  const reloaded = (await import(
    new URL("./greeting.ts?session=2", import.meta.url).href
  )) as typeof import("./greeting.ts");
  const second = reloaded.greeting(null, at(9, 1));
  assert.ok(textsOf("morning").has(second));
  assert.notEqual(second, first);
});

test("a full shuffle shows every line once before repeating", () => {
  resetGreetings();
  const seen = new Set<string>();
  let last = "";
  for (let draw = 0; draw < 12; draw += 1) {
    const entry = drawGreeting("night");
    seen.add(entry.id);
    last = entry.id;
  }
  assert.equal(seen.size, 12);

  // The next cycle starts on a different line, never the one just shown.
  const next = drawGreeting("night");
  assert.notEqual(next.id, last);
  assert.equal(stored().windows.night.queue.length, 11);
});

test("each window rotates on its own", () => {
  resetGreetings();
  drawGreeting("night");
  const state = stored();
  assert.equal(state.windows.night.queue.length, 11);
  assert.equal(state.windows.morning, undefined);
});

test("only Good morning. and Good evening. take a name", () => {
  const named = all.filter((entry) => entry.named);
  assert.deepEqual(named.map((entry) => entry.id).sort(), [
    "good-evening",
    "good-morning",
  ]);

  const morning = GREETINGS.early.find((entry) => entry.id === "good-morning")!;
  assert.equal(renderGreeting(morning, "Lidor"), "Good morning, Lidor");
  assert.equal(renderGreeting(morning, "Lidor German"), "Good morning, Lidor");
  assert.equal(renderGreeting(morning, "  Lidor  "), "Good morning, Lidor");
  assert.equal(renderGreeting(morning, "   "), "Good morning.");
  // A name is text, never a replacement pattern.
  assert.equal(renderGreeting(morning, "A$&B"), "Good morning, A$&B");
  assert.equal(renderGreeting(morning, null), "Good morning.");
  assert.equal(renderGreeting(morning, undefined), "Good morning.");

  const evening = GREETINGS.evening.find((entry) => entry.id === "good-evening")!;
  assert.equal(renderGreeting(evening, "Lidor"), "Good evening, Lidor");
  assert.equal(renderGreeting(evening, ""), "Good evening.");

  for (const entry of all) {
    if (entry.named) continue;
    assert.equal(renderGreeting(entry, "Lidor"), entry.text, entry.id);
  }
});

test("the named form is the same draw, not a second one", () => {
  resetGreetings();
  // Seed the exactly-one-entry queue so this is the line the session draws.
  // "Good morning." belongs to the early window.
  store.setItem(
    GREETING_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      windows: { early: { queue: ["good-morning"], last: null } },
    }),
  );

  assert.equal(greeting(null, at(6, 0)), "Good morning.");
  // The name arrives after the draw (auth loads): still one entry, one draw.
  assert.equal(greeting("Lidor", at(6, 1)), "Good morning, Lidor");
  assert.equal(stored().windows.early.last, "good-morning");
  assert.equal(stored().windows.early.queue.length, 0);
});
