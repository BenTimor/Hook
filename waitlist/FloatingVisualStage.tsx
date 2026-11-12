import type { CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HookMark } from "../src/components/HookMark";
import { interests } from "./interests";

const positions = [
  { left: "6%", top: "11%" },
  { left: "44%", top: "27%" },
  { left: "10%", top: "45%" },
  { left: "43%", top: "55%" },
];

export function FloatingVisualStage({ selected }: { selected: string[] }) {
  const reduced = useReducedMotion();
  return (
    <div
      className="floating-stage"
      aria-hidden="true"
      data-count={selected.length}
    >
      <div className="stage-glow" />
      <div className="stage-outline" />
      <AnimatePresence>
        {selected.length === 0 && (
          <motion.div
            className="stage-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: reduced ? 0 : 0.2 }}
          >
            <HookMark />
            <p>
              Your possibilities,
              <br />
              <em>your way.</em>
            </p>
          </motion.div>
        )}
        {selected.map((id, index) => {
          const interest = interests.find((item) => item.id === id)!;
          const { Icon, Preview } = interest;
          const compact = index < selected.length - 4;
          const slot = index - Math.max(0, selected.length - 4);
          const position =
            selected.length === 1
              ? { left: "21%", top: "30%" }
              : positions[Math.max(0, slot)];
          return (
            <motion.div
              key={id}
              layout
              className="visual-object"
              data-interest={id}
              data-compact={compact}
              data-latest={index === selected.length - 1}
              style={
                {
                  ...(compact
                    ? { left: `${9 + index * 14}%`, top: "87%" }
                    : position),
                  zIndex: index + 1,
                  "--float-delay": `${index * -1.1}s`,
                  "--object-index": index,
                } as CSSProperties
              }
              initial={{ opacity: 0, scale: 0.78, x: 35, rotate: -3 }}
              animate={{ opacity: 1, scale: 1, x: 0, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.65, x: 28 }}
              transition={
                reduced
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 155, damping: 23, mass: 0.85 }
              }
            >
              <div className="floating-surface">
                <span className="object-mini">
                  <Icon size={19} />
                </span>
                <div className="object-details">
                  <span className="object-label">
                    <Icon size={12} />
                    {interest.label}
                  </span>
                  <Preview />
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
