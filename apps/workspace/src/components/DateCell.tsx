import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function parseDateField(value: string): { year: number; month: number; day: number; time: string } | null {
  if (!value) return null;
  const [date, time = ""] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month: month - 1, day, time: time.slice(0, 5) };
}

function formatDateField(value: string, withTime: boolean): string {
  const parsed = parseDateField(value);
  if (!parsed) return "";
  const formatted = `${pad2(parsed.day)}/${pad2(parsed.month + 1)}/${parsed.year}`;
  return withTime && parsed.time ? `${formatted}, ${parsed.time}` : formatted;
}

/** A locale-independent date field: always dd/mm/yyyy, with Hook's own calendar. */
export function DateCell({
  value,
  type,
  label,
  disabled = false,
  onChange,
}: {
  value: string;
  type: "date" | "datetime";
  label: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const withTime = type === "datetime";
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const selected = parseDateField(value);
  const today = new Date();
  const todayIso = isoDate(today.getFullYear(), today.getMonth(), today.getDate());
  const formatted = formatDateField(value, withTime);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popover.current?.contains(target)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const reposition = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const show = () => {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const now = new Date();
    const base = parseDateField(value);
    setView({
      year: base?.year ?? now.getFullYear(),
      month: base?.month ?? now.getMonth(),
    });
    const width = 286;
    const height = 354;
    const left = Math.max(
      12,
      Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12),
    );
    const below = rect.bottom + 6;
    const top = below + height <= window.innerHeight - 12 || rect.top < height + 18
      ? below
      : rect.top - height - 6;
    setPosition({ top: Math.max(12, top), left });
    setOpen(true);
  };

  const chooseDay = (day: number) => {
    const iso = isoDate(view.year, view.month, day);
    onChange(withTime ? `${iso}T${selected?.time || "09:00"}` : iso);
    setOpen(false);
  };

  const chooseToday = () => {
    onChange(withTime ? `${todayIso}T${selected?.time || "09:00"}` : todayIso);
    setOpen(false);
  };

  const changeTime = (time: string) => {
    const date = selected ? isoDate(selected.year, selected.month, selected.day) : todayIso;
    onChange(`${date}T${time || "09:00"}`);
  };

  const moveMonth = (step: number) => {
    setView((current) => {
      const next = new Date(current.year, current.month + step, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const cells: Array<number | null> = [];
  const firstDay = (new Date(view.year, view.month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  for (let i = 0; i < firstDay; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ws-date-cell"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={show}
      >
        {withTime ? <CalendarClock aria-hidden="true" /> : <CalendarDays aria-hidden="true" />}
        <span aria-hidden="true">{formatted || (withTime ? "dd/mm/yyyy, --:--" : "dd/mm/yyyy")}</span>
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popover}
              className="ws-calendar"
              style={{ top: position.top, left: position.left }}
              role="dialog"
              aria-label={`${label} calendar`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="ws-calendar-head">
                <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)}>
                  <ChevronLeft />
                </button>
                <strong>{MONTH_NAMES[view.month]} {view.year}</strong>
                <button type="button" aria-label="Next month" onClick={() => moveMonth(1)}>
                  <ChevronRight />
                </button>
              </div>
              <div className="ws-calendar-week" aria-hidden="true">
                {WEEKDAY_NAMES.map((day) => <span key={day}>{day}</span>)}
              </div>
              <div className="ws-calendar-grid">
                {cells.map((day, index) => day === null ? (
                  <span className="ws-calendar-empty" key={`empty-${index}`} />
                ) : (
                  <button
                    key={day}
                    type="button"
                    className="ws-calendar-day"
                    data-today={isoDate(view.year, view.month, day) === todayIso}
                    data-selected={
                      selected?.year === view.year &&
                      selected?.month === view.month &&
                      selected?.day === day
                    }
                    aria-label={`${pad2(day)}/${pad2(view.month + 1)}/${view.year}`}
                    onClick={() => chooseDay(day)}
                  >
                    {day}
                  </button>
                ))}
              </div>
              {withTime ? (
                <label className="ws-calendar-time">
                  <span>Time</span>
                  <input
                    type="time"
                    value={selected?.time || "09:00"}
                    onChange={(event) => changeTime(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="ws-calendar-foot">
                <button type="button" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
                <button type="button" onClick={chooseToday}>Today</button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
