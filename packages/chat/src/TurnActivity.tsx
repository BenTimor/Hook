import { useEffect, useRef, useState } from "react";

/** How long a label stays on screen before the next one may take its place. */
const DWELL = 320;
/** How long the last label lingers before the line falls back to "Thinking". */
const LINGER = 520;
/** Labels allowed to wait behind the one on screen. Older ones are skipped. */
const PENDING = 2;

/**
 * What a running turn is doing, in one line.
 *
 * The labels come from the backend just before each tool runs. Tools arrive in
 * batches and some of them finish in a few milliseconds, so the pacing lives
 * here: every label gets a minimum time on screen, and when more than
 * `PENDING` are waiting the oldest are dropped instead of shown late. The line
 * may skip a step, but it never describes work that has already finished.
 *
 * It renders as the place the reply will appear: the dots stay, the words
 * crossfade, and when text starts streaming the whole line gives way to it.
 */
export function TurnActivity({ labels }: { labels: string[] }) {
  const [index, setIndex] = useState(-1);
  const [thinking, setThinking] = useState(true);
  const shownAt = useRef(0);
  const latest = useRef(labels);
  latest.current = labels;

  useEffect(() => {
    if (labels.length === 0) {
      setIndex(-1);
      setThinking(true);
      return;
    }
    const target = next(labels.length, index);
    if (target === index) return;

    const show = (at: number) => {
      setIndex(at);
      setThinking(false);
      shownAt.current = Date.now();
    };

    // The first label takes over from "Thinking" at once; after that the
    // current one keeps its time.
    if (index === -1 || Date.now() - shownAt.current >= DWELL) {
      show(target);
      return;
    }
    const wait = DWELL - (Date.now() - shownAt.current);
    const timer = window.setTimeout(() => show(next(latest.current.length, index)), wait);
    return () => window.clearTimeout(timer);
  }, [labels, index]);

  // Between tools the model is thinking again. Let the last label sit for a
  // moment first: a flash of "Thinking" between two tools reads as a glitch.
  useEffect(() => {
    if (labels.length === 0 || index < labels.length - 1) {
      setThinking(labels.length === 0);
      return;
    }
    if (thinking) return;
    const timer = window.setTimeout(() => setThinking(true), LINGER);
    return () => window.clearTimeout(timer);
  }, [labels, index, thinking]);

  const label = index >= 0 && index < labels.length ? labels[index] : null;

  return (
    <div className="activity" role="status">
      <span className="activity-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <SwappingText text={thinking || !label ? "Thinking…" : label} />
    </div>
  );
}

/**
 * The next label worth showing: one step on from the current one, unless that
 * would leave more than `PENDING` waiting, in which case it skips ahead.
 */
function next(count: number, index: number): number {
  return Math.min(count - 1, Math.max(index + 1, count - 1 - PENDING));
}

/** Crossfades the words only: the dots beside them never flinch. */
function SwappingText({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  const current = useRef(text);

  useEffect(() => {
    if (text === current.current) return;
    const previous = current.current;
    current.current = text;
    setLeaving(previous);
    setShown(text);
    const timer = window.setTimeout(() => setLeaving(null), 170);
    return () => window.clearTimeout(timer);
  }, [text]);

  return (
    <span className="activity-text">
      {leaving ? (
        <span className="activity-leaving" aria-hidden="true">
          {leaving}
        </span>
      ) : null}
      <span className={leaving ? "activity-arriving" : undefined}>{shown}</span>
    </span>
  );
}
