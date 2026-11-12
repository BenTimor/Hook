import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  ArrowRight,
  CircleCheck,
  Gauge,
  MousePointer2,
  UserRoundPlus,
} from "lucide-react";
import "@fontsource-variable/inter/wght.css";
import { HookMark } from "../src/components/HookMark";
import { ProductPreview } from "./ProductPreview";
import { OnboardingTransition } from "./OnboardingTransition";
import {
  ConfirmationScreen,
  InterestsScreen,
  PricingScreen,
} from "./OnboardingPanels";
import {
  rememberOnboarding,
  restoreOnboarding,
  usageBenefit,
  usageDescription,
} from "./onboarding";
import type { Profile, Screen } from "./onboarding";
import { resumeOnboarding, useProgressSaver } from "./progress";
import { developmentPreview } from "./devMode";
import "./styles.css";
import "./onboarding.css";

const ORDER = {
  landing: 0,
  interests: 1,
  pricing: 2,
  confirmation: 3,
};
const BENEFITS = [
  { Icon: Gauge, label: usageBenefit },
  { Icon: MousePointer2, label: "Less effort" },
  { Icon: CircleCheck, label: "More done" },
];
const CALLBACK_ERRORS = new Map([
  [
    "cancelled",
    "Google sign-in was canceled. Try again whenever you’re ready.",
  ],
  ["expired", "Your sign-in session expired. Please try again."],
  ["unverified", "Please use a Google account with a verified email address."],
  ["failed", "We couldn’t complete Google sign-in. Please try again."],
]);

function Waitlist() {
  const [onboarding, setOnboarding] = useState(restoreOnboarding);
  const [direction, setDirection] = useState(1);
  const [profile, setProfile] = useState<Profile | null>(null);
  const progress = useProgressSaver(profile?.id);
  const [checking, setChecking] = useState(!developmentPreview);
  const [busy, setBusy] = useState(false);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState(() =>
    developmentPreview
      ? ""
      : (CALLBACK_ERRORS.get(
          new URLSearchParams(location.search).get("signup") ?? "",
        ) ?? ""),
  );
  const reduced = useReducedMotion();

  function go(screen: Screen) {
    setDirection(ORDER[screen] >= ORDER[onboarding.screen] ? 1 : -1);
    setOnboarding((current) => ({ ...current, screen }));
  }

  useEffect(() => rememberOnboarding(onboarding), [onboarding]);

  useEffect(() => {
    const completed = progress.completedProfile;
    if (completed && completed.id === profile?.id) {
      setError("");
      setProfile(completed);
      setOnboarding(resumeOnboarding(completed));
    }
  }, [progress.completedProfile]);

  useEffect(() => {
    let active = true;
    const url = new URL(location.href);
    const callbackError = error;
    if (url.searchParams.has("signup")) {
      url.searchParams.delete("signup");
      history.replaceState(history.state, "", url);
    }

    async function checkStatus() {
      if (developmentPreview) return;
      try {
        const response = await fetch("/api/waitlist/status", {
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error("Status unavailable");
        const status = await response.json();
        if (!active) return;
        setProfile(status.profile ?? null);
        if (status.profile && !callbackError)
          setOnboarding(resumeOnboarding(status.profile));
        else
          setOnboarding((current) => ({
            ...current,
            screen:
              status.joined && !callbackError ? "confirmation" : "landing",
          }));
      } catch {
        // Browsing the introduction works while the signup service is offline.
        if (active)
          setOnboarding((current) => ({ ...current, screen: "landing" }));
      } finally {
        if (active) {
          setChecking(false);
          setBusy(false);
        }
      }
    }

    function restore(event: PageTransitionEvent) {
      if (event.persisted) void checkStatus();
    }
    function visibility() {
      setVisible(document.visibilityState === "visible");
    }
    visibility();
    void checkStatus();
    window.addEventListener("pageshow", restore);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false;
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  async function signUp(force = false) {
    if (busy || checking) return;
    setError("");
    if (developmentPreview) {
      go("interests");
      return;
    }
    if (profile && !force) {
      go("interests");
      void progress.record([{ type: "step_changed", step: "interests" }]);
      return;
    }
    setBusy(true);
    try {
      rememberOnboarding(onboarding);
      const response = await fetch("/api/waitlist/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "onboarding" }),
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 503) {
        setError(
          "Google sign-in is unavailable right now. Please try again later.",
        );
        setBusy(false);
        return;
      }
      if (!response.ok) throw new Error("Could not open Google sign-in");
      const result = await response.json();
      if (result.authenticated && result.profile) {
        setProfile(result.profile);
        setDirection(1);
        setOnboarding(resumeOnboarding(result.profile));
        setBusy(false);
      } else {
        location.assign(result.url);
      }
    } catch {
      setError("We couldn’t open Google sign-in. Please try again.");
      setBusy(false);
    }
  }

  async function choosePlan(planPreference: string) {
    if (busy || (!profile && !developmentPreview)) return;
    setBusy(true);
    setBusyPlan(planPreference);
    setError("");
    setOnboarding((current) => ({ ...current, planPreference }));
    const selected = await progress.record([
      { type: "plan_selected", planPreference },
    ]);
    const completed =
      selected &&
      (await progress.record([{ type: "completed", planPreference }]));
    setBusy(false);
    setBusyPlan(null);
    if (completed) go("confirmation");
    else
      setError(
        "Your choices are kept on this device. We couldn’t finish saving them. Please retry.",
      );
  }

  const screen = checking ? "landing" : onboarding.screen;
  const step = ORDER[screen];
  return (
    <MotionConfig reducedMotion="user">
      <div className="site" data-screen={screen} data-visible={visible}>
        <motion.div
          className="site-atmosphere"
          aria-hidden="true"
          animate={{ x: reduced ? 0 : step * -18 }}
          transition={{ type: "spring", stiffness: 80, damping: 25 }}
        />
        <header className="site-header">
          <button
            className="wordmark"
            onClick={() => go("landing")}
            disabled={busy}
            aria-label="Hook home"
          >
            <HookMark />
            Hook
          </button>
          {step === 0 ? (
            <span className="availability">
              <span aria-hidden="true" />
              {developmentPreview ? "Local preview" : "Early access"}
            </span>
          ) : (
            <nav
              className="onboarding-progress"
              aria-label="Onboarding progress"
            >
              {["Your interests", "Your plan", "Your spot"].map(
                (label, index) => (
                  <span
                    key={label}
                    aria-current={step === index + 1 ? "step" : undefined}
                  >
                    <i>{index + 1}</i>
                    <span>{label}</span>
                  </span>
                ),
              )}
            </nav>
          )}
        </header>

        <main className="screen-stack">
          <AnimatePresence initial={false} custom={direction}>
            <OnboardingTransition
              key={screen}
              screen={screen}
              direction={direction}
            >
              {screen === "landing" && (
                <>
                  <div className="hero">
                    <div className="hero-copy">
                      <h1 tabIndex={-1}>You don’t need to understand AI.</h1>
                      <p className="subheadline">You just need to use it.</p>
                      <p className="description">{usageDescription}</p>
                      <div className="signup">
                        <button
                          className="join-button"
                          onClick={() => void signUp()}
                          disabled={busy || checking}
                          aria-busy={busy || checking}
                        >
                          <span className="join-icon">
                            <UserRoundPlus
                              size={17}
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                          </span>
                          <span>{busy ? "Opening Google…" : "Hook Me In"}</span>
                          {busy ? (
                            <span className="spinner" aria-hidden="true" />
                          ) : (
                            <ArrowRight
                              size={17}
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                          )}
                        </button>
                        <p className="signup-note">
                          {developmentPreview
                            ? "Local preview · Google sign-in skipped"
                            : "Sign up with Google"}
                        </p>
                        {error && (
                          <p className="signup-error" role="alert">
                            {error}
                          </p>
                        )}
                      </div>
                    </div>
                    <ProductPreview />
                  </div>
                  <ul className="benefits" aria-label="Hook benefits">
                    {BENEFITS.map(({ Icon, label }) => (
                      <li key={label}>
                        <span className="benefit-icon">
                          <Icon
                            size={17}
                            strokeWidth={1.65}
                            aria-hidden="true"
                          />
                        </span>
                        {label}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {screen === "interests" && (
                <InterestsScreen
                  selected={onboarding.interests}
                  onToggle={(id) => {
                    const selected = !onboarding.interests.includes(id);
                    setOnboarding((current) => ({
                      ...current,
                      interests: current.interests.includes(id)
                        ? current.interests.filter((item) => item !== id)
                        : [...current.interests, id],
                    }));
                    void progress.record([
                      { type: "interest_changed", interestId: id, selected },
                    ]);
                  }}
                  onBack={() => go("landing")}
                  onSkip={() => {
                    setDirection(1);
                    void progress.record([
                      ...onboarding.interests.map((interestId) => ({
                        type: "interest_changed" as const,
                        interestId,
                        selected: false,
                      })),
                      { type: "step_changed", step: "pricing" },
                    ]);
                    setOnboarding((current) => ({
                      ...current,
                      interests: [],
                      screen: "pricing",
                    }));
                  }}
                  onNext={() => {
                    void progress.record([
                      { type: "step_changed", step: "pricing" },
                    ]);
                    go("pricing");
                  }}
                />
              )}
              {screen === "pricing" && (
                <PricingScreen
                  preference={onboarding.planPreference}
                  busy={busy}
                  busyPlan={busyPlan}
                  error={error}
                  onBack={() => {
                    setError("");
                    void progress.record([
                      { type: "step_changed", step: "interests" },
                    ]);
                    go("interests");
                  }}
                  onChoose={(planPreference) => void choosePlan(planPreference)}
                />
              )}
              {screen === "confirmation" && (
                <ConfirmationScreen onHome={() => go("landing")} />
              )}
            </OnboardingTransition>
          </AnimatePresence>
        </main>

        <footer
          className="site-footer"
          data-syncing={screen === "interests" || screen === "pricing"}
        >
          <p>© {new Date().getFullYear()} Hook</p>
          {(screen === "interests" || screen === "pricing") && (
            <div className="progress-save" role="status" aria-live="polite">
              {developmentPreview ? (
                "Preview · not saved"
              ) : progress.state === "error" ? (
                <button
                  onClick={() =>
                    progress.authRequired
                      ? void signUp(true)
                      : void progress.retry()
                  }
                >
                  {progress.authRequired ? "Sign in to save" : "Retry save"}
                </button>
              ) : progress.state === "saving" ? (
                "Saving…"
              ) : (
                "Saved"
              )}
            </div>
          )}
          <nav aria-label="Legal and contact">
            <a href="/privacy" target="_blank" rel="noopener">
              Privacy
            </a>
            <span aria-hidden="true">·</span>
            <a href="/terms" target="_blank" rel="noopener">
              Terms
            </a>
            <span aria-hidden="true">·</span>
            <a href="mailto:nsgi3111@gmail.com">Contact</a>
          </nav>
        </footer>
      </div>
    </MotionConfig>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Waitlist />
  </StrictMode>,
);
