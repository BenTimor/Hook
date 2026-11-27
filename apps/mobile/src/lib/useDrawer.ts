import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const drawerWidth = () => Math.min(window.innerWidth * 0.86, 340);

/** The drawer is opened over the composer; a keyboard left up would cover it. */
function dismissKeyboard() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

/**
 * The drawer's touch model: an edge swipe opens it, a left swipe closes it.
 *
 * Pointer events, not scroll events, so the drawer can follow the thumb before
 * it commits. The drawer panel keeps `touch-action: pan-y`, so a vertical
 * gesture is a normal scroll and the drag is abandoned; the narrow edge strip
 * uses `touch-action: none`, because an edge swipe must not scroll the page.
 */
export function useDrawer() {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [drag, setDrag] = useState(0);
  const [width, setWidth] = useState(drawerWidth);
  const dragRef = useRef(0);
  const suppressClick = useRef(false);
  const start = useRef<{
    x: number;
    y: number;
    fromOpen: boolean;
    decided: boolean;
    pointerId: number;
  } | null>(null);

  const setDragValue = (value: number) => {
    dragRef.current = value;
    setDrag(value);
  };

  const openDrawer = () => {
    dismissKeyboard();
    const next = drawerWidth();
    setWidth(next);
    setDragValue(next);
    setOpen(true);
  };

  const closeDrawer = () => {
    setDragging(false);
    setDragValue(0);
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
    start.current = {
      x: event.clientX,
      y: event.clientY,
      fromOpen,
      decided: false,
      pointerId: event.pointerId,
    };
    setDragValue(fromOpen ? next : 0);
    setDragging(false);
    if (!fromOpen) event.currentTarget.setPointerCapture(event.pointerId);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = start.current;
    if (!gesture) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // A vertical gesture is the drawer's own list scrolling.
        start.current = null;
        setDragging(false);
        setDragValue(gesture.fromOpen ? drawerWidth() : 0);
        return;
      }
      gesture.decided = true;
      suppressClick.current = true;
      setDragging(true);
    }
    const limit = drawerWidth();
    const next = gesture.fromOpen ? limit + dx : dx;
    setDragValue(Math.max(0, Math.min(limit, next)));
  };

  const end = () => {
    const gesture = start.current;
    if (!gesture) return;
    start.current = null;
    const limit = drawerWidth();
    const shouldOpen = dragRef.current > limit * 0.35;
    setDragging(false);
    setDragValue(shouldOpen ? limit : 0);
    setOpen(shouldOpen);
    // The click that follows pointerup belongs to the row that was swiped
    // across, not to the gesture. Let it pass only when no drag happened.
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const edgeProps = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => begin(event, false),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
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
    style: dragging
      ? { transform: `translateX(${drag - width}px)`, transition: "none" }
      : undefined,
    backdropStyle: dragging
      ? { opacity: Math.min(1, drag / Math.max(1, width)) }
      : undefined,
  };
}
