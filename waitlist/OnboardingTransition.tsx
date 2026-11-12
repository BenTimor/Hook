import { useRef } from "react";
import type { ReactNode } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";

export function OnboardingTransition({
  direction,
  children,
  screen,
}: {
  direction: number;
  children: ReactNode;
  screen: string;
}) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const element = useRef<HTMLElement>(null);
  return (
    <motion.section
      ref={element}
      className={`screen ${screen}-screen`}
      data-screen={screen}
      inert={!present}
      aria-hidden={!present}
      custom={direction}
      variants={{
        enter: (sign: number) => ({
          x: reduced ? 0 : `${sign * 110}vw`,
          opacity: reduced ? 0 : 1,
        }),
        center: { x: 0, opacity: 1 },
        exit: (sign: number) => ({
          x: reduced ? 0 : `${sign * -110}vw`,
          opacity: reduced ? 0 : 1,
        }),
      }}
      initial="enter"
      animate="center"
      exit="exit"
      transition={
        reduced
          ? { duration: 0 }
          : { type: "spring", stiffness: 145, damping: 27, mass: 1 }
      }
      onAnimationComplete={() => {
        if (present)
          element.current
            ?.querySelector<HTMLElement>("h1")
            ?.focus({ preventScroll: true });
      }}
    >
      {children}
    </motion.section>
  );
}
