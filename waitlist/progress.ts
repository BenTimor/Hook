import { useEffect, useMemo, useRef, useState } from "react";
import content from "./content.json";
import { developmentPreview } from "./devMode";
import type { OnboardingState, Profile } from "./onboarding";

export type ProgressAction =
  | { type: "interest_changed"; interestId: string; selected: boolean }
  | { type: "step_changed"; step: "interests" | "pricing" }
  | { type: "plan_selected"; planPreference: string }
  | { type: "completed"; planPreference: string };

export type ProgressEvent = ProgressAction & {
  eventId: string;
  clientId: string;
  sequence: number;
};

interface ProgressSession {
  subject: string;
  events: ProgressEvent[];
  active: boolean;
  pumping: Promise<boolean> | null;
}

const storageKey = (subject: string) => `hook-pending-progress-v1:${subject}`;
const interestIds = new Set(content.interests.map((interest) => interest.id));
const planIds = new Set(content.pricing.plans.map((plan) => plan.id));

export function pendingProgress(subject: string): ProgressEvent[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(subject)) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter((event) => {
      if (
        !event ||
        typeof event.eventId !== "string" ||
        typeof event.clientId !== "string" ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1
      )
        return false;
      return (
        (event.type === "interest_changed" &&
          interestIds.has(event.interestId) &&
          typeof event.selected === "boolean") ||
        (event.type === "step_changed" &&
          ["interests", "pricing"].includes(event.step)) ||
        (["plan_selected", "completed"].includes(event.type) &&
          planIds.has(event.planPreference))
      );
    });
  } catch {
    return [];
  }
}

export function resumeOnboarding(profile: Profile): OnboardingState {
  const restored: OnboardingState = {
    interests: [...profile.interests],
    planPreference: profile.planPreference,
    screen:
      profile.onboardingStep === "completed"
        ? "confirmation"
        : profile.onboardingStep,
  };
  for (const event of pendingProgress(profile.id)) {
    if (event.type === "interest_changed") {
      restored.interests = event.selected
        ? [...new Set([...restored.interests, event.interestId])]
        : restored.interests.filter((id) => id !== event.interestId);
    } else if (event.type === "step_changed") {
      restored.screen = event.step;
    } else if (event.type === "plan_selected") {
      restored.planPreference = event.planPreference;
      restored.screen = "pricing";
    } else {
      restored.screen = "confirmation";
    }
  }
  // A pending completion still needs a successful server acknowledgement.
  if (
    profile.onboardingStep !== "completed" &&
    restored.screen === "confirmation"
  )
    restored.screen = "pricing";
  return restored;
}

function persist(session: ProgressSession) {
  try {
    if (session.events.length)
      localStorage.setItem(
        storageKey(session.subject),
        JSON.stringify(session.events),
      );
    else localStorage.removeItem(storageKey(session.subject));
  } catch {
    // Keep the in-memory queue and unload delivery available when storage is restricted.
  }
}

export function useProgressSaver(subject: string | undefined) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [authRequired, setAuthRequired] = useState(false);
  const [completedProfile, setCompletedProfile] = useState<Profile | null>(
    null,
  );
  const clientId = useRef(crypto.randomUUID());
  const sequence = useRef(0);
  const session = useMemo<ProgressSession | null>(
    () =>
      subject && !developmentPreview
        ? {
            subject,
            events: pendingProgress(subject),
            active: true,
            pumping: null,
          }
        : null,
    [subject],
  );

  function sync(current: ProgressSession): Promise<boolean> {
    if (current.pumping) return current.pumping;
    const work = (async () => {
      if (current.active && current.events.length) setState("saving");
      let lastProfile: Profile | null = null;
      let completed = false;
      try {
        while (current.events.length) {
          const events = current.events.slice(0, 25);
          const response = await fetch("/api/waitlist/progress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subject: current.subject, events }),
            signal: AbortSignal.timeout(10000),
            keepalive: true,
          });
          if (!response.ok) {
            const failure = await response.json().catch(() => ({}));
            if (current.active)
              setAuthRequired(
                response.status === 401 || failure.error === "account_changed",
              );
            throw new Error("Progress could not be saved");
          }
          lastProfile = (await response.json()).profile;
          completed ||= events.some((event) => event.type === "completed");
          const delivered = new Set(events.map((event) => event.eventId));
          current.events = current.events.filter(
            (event) => !delivered.has(event.eventId),
          );
          persist(current);
        }
        if (current.active) {
          setAuthRequired(false);
          setState("saved");
          if (completed && lastProfile?.onboardingStep === "completed")
            setCompletedProfile(lastProfile);
        }
        return true;
      } catch {
        if (current.active) setState("error");
        return false;
      }
    })();
    current.pumping = work;
    void work.finally(() => {
      if (current.pumping === work) current.pumping = null;
    });
    return work;
  }

  useEffect(() => {
    if (!session) {
      setState("idle");
      setAuthRequired(false);
      return;
    }
    session.active = true;
    setCompletedProfile(null);
    setState(session.events.length ? "saving" : "saved");
    if (session.events.length) void sync(session);

    function flushOnExit() {
      if (!session?.events.length) return;
      for (let index = 0; index < session.events.length; index += 25) {
        const body = JSON.stringify({
          subject: session.subject,
          events: session.events.slice(index, index + 25),
        });
        const delivered = navigator.sendBeacon?.(
          "/api/waitlist/progress",
          new Blob([body], { type: "application/json" }),
        );
        if (!delivered)
          void fetch("/api/waitlist/progress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          }).catch(() => {});
      }
    }
    function retry() {
      if (session) void sync(session);
    }
    function visibility() {
      if (document.visibilityState === "hidden") flushOnExit();
      else retry();
    }
    window.addEventListener("online", retry);
    window.addEventListener("pagehide", flushOnExit);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      session.active = false;
      window.removeEventListener("online", retry);
      window.removeEventListener("pagehide", flushOnExit);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [session]);

  function record(actions: ProgressAction[]) {
    if (developmentPreview) return Promise.resolve(true);
    if (!session) return Promise.resolve(false);
    session.events.push(
      ...actions.map((action) => ({
        ...action,
        eventId: crypto.randomUUID(),
        clientId: clientId.current,
        sequence: ++sequence.current,
      })),
    );
    persist(session);
    setState("saving");
    return sync(session);
  }

  return {
    state,
    authRequired,
    completedProfile,
    record,
    retry: () => (session ? sync(session) : Promise.resolve(false)),
  };
}
