import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const drawerWidth = () => Math.min(window.innerWidth * 0.86, 340);

/** How much of the drawer a drag has to cover to commit, unless it flicks. */
const OPEN_FRACTION = 0.32;

/** A release faster than this (px/ms) decides for the direction it travels. */
const FLICK = 0.4;

/** The drawer is opened over the composer; a keyboard left up would cover it. */
function dismissKeyboard() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

type Sample = { x: number; t: number };

type Gesture = {
  startX: number;
  startY: number;
  /** The offset the drag started from: 0 closed, the width open. */
  base: number;
  fromOpen: boolean;
  decided: boolean;
  samples: Sample[];
};

/** The release speed over roughly the last 50ms, in px/ms (right is positive). */
function releaseSpeed(samples: Sample[], now: number): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  // A finger that stopped before letting go is not a flick, however fast it
  // was travelling when it stopped.
  if (now - last.t > 120) return 0;
  let first = samples[0];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (last.t - samples[index].t >= 50) {
      first = samples[index];
      break;
    }
  }
  const elapsed = last.t - first.t;
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

/**
 * The drawer's touch model.
 *
 * One gesture, two directions: a right-swipe from the edge opens it and a
 * left-swipe on the panel closes it. Both follow the thumb, both move the same
 * surface and the same scrim, and both settle with the same transition — a
 * closed drawer is the open one pushed off the left edge, not a second
 * animation. A release either commits in the direction it was going (distance
 * past a third of the width, or a flick) or springs back where it started.
 *
 * Pointer events, not scroll events, so the drawer tracks the finger before it
 * commits. The panel keeps `touch-action: pan-y`, so a vertical gesture is a
 * normal scroll and the drag is abandoned; the narrow edge strip uses
 * `touch-action: none`, because an edge swipe must not scroll the page.
 */
export function useDrawer() {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 0 while closed, the drawer's width while open, anything between in a drag. */
  const [offset, setOffset] = useState(0);
  const [width, setWidth] = useState(drawerWidth);
  const offsetRef = useRef(0);
  const suppressClick = useRef(false);
  const gesture = useRef<Gesture | null>(null);

  const setOffsetValue = (value: number) => {
    offsetRef.current = value;
    setOffset(value);
  };

  const openDrawer = () => {
    dismissKeyboard();
    gesture.current = null;
    const next = drawerWidth();
    setWidth(next);
    setDragging(false);
    setOffsetValue(next);
    setOpen(true);
  };

  const closeDrawer = () => {
    gesture.current = null;
    setDragging(false);
    setOffsetValue(0);
    setOpen(false);
  };

  const begin = (event: ReactPointerEvent<HTMLDivElement>, fromOpen: boolean) => {
    if (!event.isPrimary || event.button !== 0) return;
    const target = event.target as Element | null;
    // Typing and selection own the gesture inside a field. Buttons are allowed:
    // a swipe across a row must not open it, and the click is suppressed below.
    if (target?.closest("input, textarea, select, a")) return;
    dismissKeyboard();
    const next = drawerWidth();
    setWidth(next);
    gesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      base: fromOpen ? next : 0,
      fromOpen,
      decided: false,
      samples: [{ x: event.clientX, t: performance.now() }],
    };
    setDragging(false);
    setOffsetValue(fromOpen ? next : 0);
    if (!fromOpen) {
      // The strip has no tappable children, so capturing here is safe and keeps
      // the drag tracking after the finger leaves the 22px edge.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A synthetic pointer can refuse capture; the drag still works.
      }
    }
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // A vertical gesture is the drawer's own list scrolling.
        gesture.current = null;
        setDragging(false);
        setOffsetValue(current.base);
        return;
      }
      current.decided = true;
      suppressClick.current = true;
      setDragging(true);
    }
    current.samples.push({ x: event.clientX, t: performance.now() });
    if (current.samples.length > 8) current.samples.shift();
    const limit = drawerWidth();
    setOffsetValue(Math.max(0, Math.min(limit, current.base + dx)));
  };

  const end = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    const limit = drawerWidth();
    const speed = releaseSpeed(current.samples, performance.now());
    // The distance actually travelled, so the same third of the width commits
    // opening and closing; without it a close would have to cross two thirds.
    const travelled = Math.abs(offsetRef.current - current.base) / Math.max(1, limit);
    // A decision only exists when the drag was horizontal; a plain tap keeps
    // what it had (open on the panel, closed on the edge strip).
    const shouldOpen = current.decided
      ? speed > FLICK
        ? true
        : speed < -FLICK
          ? false
          : current.fromOpen
            ? travelled < OPEN_FRACTION
            : travelled > OPEN_FRACTION
      : current.fromOpen;
    setDragging(false);
    setOffsetValue(shouldOpen ? limit : 0);
    setOpen(shouldOpen);
    // The click that follows pointerup belongs to the row that was swiped
    // across, not to the gesture. Let it pass only when no drag happened.
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  // The whole dimmed screen is a dismissal surface: a swipe from it moves the
  // same drawer, and a tap on it closes with the same transition as the X.
  const endBackdrop = () => {
    const current = gesture.current;
    if (!current) return;
    if (!current.decided) {
      gesture.current = null;
      setDragging(false);
      setOffsetValue(0);
      setOpen(false);
      return;
    }
    end();
  };

  const edgeProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => begin(event, false),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
  };

  const backdropProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => begin(event, true),
    onPointerMove: move,
    onPointerUp: endBackdrop,
    onPointerCancel: endBackdrop,
  };

  const panelProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => begin(event, true),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };

  return {
    open,
    openDrawer,
    closeDrawer,
    dragging,
    edgeProps,
    panelProps,
    backdropProps,
    style: dragging
      ? { transform: `translateX(${offset - width}px)`, transition: "none" }
      : undefined,
    backdropStyle: dragging
      ? { opacity: Math.min(1, offset / Math.max(1, width)) }
      : undefined,
  };
}
