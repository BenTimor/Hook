import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Laptop,
  LogIn,
  ShieldCheck,
} from "lucide-react";

import { HookMark } from "@hook/ui";
import type { Profile } from "./onboarding";
import "./styles.css";
import "./onboarding.css";

type StatusResponse = {
  joined: boolean;
  profile: Profile | null;
};

type Phase =
  | "checking"
  | "signed-out"
  | "waiting"
  | "ready"
  | "approving"
  | "done"
  | "error";

function displayCode(raw: string) {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === 8
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
    : raw.toUpperCase();
}

/**
 * The browser half of desktop sign-in. Hook shows the same short code; the
 * user signs in with Google here and approves the device. The desktop app is
 * polling in the background and finishes on its own.
 */
export function AuthorizePage() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const rawCode = new URLSearchParams(location.search).get("code") ?? "";
  const code = displayCode(rawCode);

  useEffect(() => {
    document.title = "Approve Hook";
    const params = new URLSearchParams(location.search);
    const signup = params.get("signup");
    if (signup && signup !== "authenticated") {
      setMessage(
        signup === "cancelled"
          ? "Google sign-in was canceled. Try again whenever you’re ready."
          : signup === "unverified"
            ? "Please use a Google account with a verified email address."
            : signup === "expired"
              ? "Your sign-in session expired. Go back to Hook and start again."
              : "We couldn’t complete Google sign-in. Please try again.",
      );
      setPhase("signed-out");
      return;
    }
    if (!rawCode) {
      setMessage("Open Hook, choose Sign in, and use the code shown there.");
      setPhase("error");
      return;
    }
    let alive = true;
    fetch("/api/waitlist/status", { signal: AbortSignal.timeout(10_000) })
      .then((response) => {
        if (!response.ok) throw new Error("status");
        return response.json() as Promise<StatusResponse>;
      })
      .then((status) => {
        if (!alive) return;
        setProfile(status.profile ?? null);
        setPhase(
          !status.profile
            ? "signed-out"
            : status.profile.approved
              ? "ready"
              : "waiting",
        );
      })
      .catch(() => {
        if (!alive) return;
        setMessage(
          "We couldn’t check your sign-in. Make sure you’re online and try again.",
        );
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [rawCode]);

  async function signIn() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/waitlist/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "onboarding",
          next: `/authorize?code=${encodeURIComponent(rawCode)}`,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 503) {
        setMessage("Google sign-in is unavailable right now. Try again later.");
        setBusy(false);
        return;
      }
      if (!response.ok) throw new Error("signin");
      const result = await response.json();
      if (result.authenticated && result.profile) {
        setProfile(result.profile);
        setPhase(result.profile.approved ? "ready" : "waiting");
        setBusy(false);
      } else {
        location.assign(result.url);
      }
    } catch {
      setMessage("We couldn’t open Google sign-in. Please try again.");
      setBusy(false);
    }
  }

  async function switchAccount() {
    try {
      await fetch("/api/waitlist/logout", {
        method: "POST",
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      // Reloading still shows the signed-out state if the network is down.
    }
    location.reload();
  }

  async function approve() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setPhase("approving");
    try {
      const response = await fetch("/api/auth/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: rawCode }),
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) {
        setPhase("done");
        return;
      }
      let error = "";
      try {
        error = (await response.json()).error ?? "";
      } catch {
        error = "";
      }
      if (error === "not_approved") {
        setMessage(
          "Hook is invite-only for now. Your account is still on the waiting list.",
        );
        setPhase("waiting");
      } else if (error === "expired") {
        setMessage(
          "That code expired. Go back to Hook and choose Sign in to get a new one.",
        );
        setPhase("error");
      } else if (error === "already_used" || error === "account_changed") {
        setMessage(
          "That code was already used. Go back to Hook and start sign-in again.",
        );
        setPhase("error");
      } else if (error === "signin_required") {
        setProfile(null);
        setPhase("signed-out");
      } else {
        setMessage("We couldn’t approve this device. Please try again.");
        setPhase("error");
      }
    } catch {
      setMessage("We couldn’t reach Hook. Check your connection and retry.");
      setPhase("ready");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="site authorize-site" data-screen="authorize">
      <div className="site-atmosphere" aria-hidden="true" />
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Hook home">
          <HookMark />
          Hook
        </a>
        <span className="availability">
          <span aria-hidden="true" />
          Desktop sign-in
        </span>
      </header>

      <main className="authorize-main">
        <motion.div
          className="authorize-card"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="authorize-icon" aria-hidden="true">
            {phase === "done" ? (
              <Check size={22} strokeWidth={2} />
            ) : (
              <Laptop size={22} strokeWidth={1.7} />
            )}
          </div>

          {phase === "checking" && (
            <>
              <p className="step-label">One moment</p>
              <h1>Checking your account…</h1>
              <p className="screen-description">
                We’re matching this browser to your Hook waiting-list account.
              </p>
              <span className="spinner authorize-spinner" aria-hidden="true" />
            </>
          )}

          {phase === "signed-out" && (
            <>
              <p className="step-label">Approve this device</p>
              <h1>Sign in to connect Hook</h1>
              <p className="screen-description">
                Use the same Google account you joined the waiting list with.
                Once you’re approved, you can finish signing in on the desktop.
              </p>
              <button
                className="primary-button authorize-action"
                onClick={() => void signIn()}
                disabled={busy}
                aria-busy={busy}
              >
                <LogIn size={17} strokeWidth={1.9} aria-hidden="true" />
                {busy ? "Opening Google…" : "Continue with Google"}
              </button>
            </>
          )}

          {phase === "waiting" && (
            <>
              <p className="step-label">Not yet</p>
              <h1>You’re still on the list.</h1>
              <p className="screen-description">
                Hook is invite-only for now. We’ll email{" "}
                <strong>{profile?.email}</strong> as soon as your account is
                approved — then come back to this page and try again.
              </p>
              <a className="text-button authorize-action" href="/">
                <ArrowLeft size={16} aria-hidden="true" />
                Back to Hook
              </a>
              <button
                className="text-button authorize-switch"
                onClick={() => void switchAccount()}
              >
                Use a different account
              </button>
            </>
          )}

          {(phase === "ready" || phase === "approving") && (
            <>
              <p className="step-label">Approve this device</p>
              <h1>Is this code showing in Hook?</h1>
              <p className="screen-description">
                Hook should be showing the same code. Check that it matches
                before approving.
              </p>
              <code className="authorize-code">{code}</code>
              <p className="authorize-email">
                Signed in as <strong>{profile?.email}</strong>
              </p>
              <button
                className="primary-button authorize-action"
                onClick={() => void approve()}
                disabled={busy || phase === "approving"}
                aria-busy={phase === "approving"}
              >
                <ShieldCheck size={17} strokeWidth={1.9} aria-hidden="true" />
                {phase === "approving" ? "Approving…" : "Approve Hook"}
              </button>
              <button
                className="text-button authorize-switch"
                onClick={() => void switchAccount()}
              >
                Use a different account
              </button>
            </>
          )}

          {phase === "done" && (
            <>
              <p className="step-label">Approved</p>
              <h1>Hook is connected.</h1>
              <p className="screen-description">
                You can close this tab and return to Hook. It finishes signing
                you in by itself.
              </p>
              <p className="authorize-done">
                <Check size={15} strokeWidth={2.2} aria-hidden="true" />
                Signed in as {profile?.email}
              </p>
            </>
          )}

          {phase === "error" && (
            <>
              <p className="step-label">Something went wrong</p>
              <h1>We couldn’t connect this device.</h1>
              <p className="screen-description">{message}</p>
              <a className="text-button authorize-action" href="/">
                <ArrowLeft size={16} aria-hidden="true" />
                Back to Hook
              </a>
            </>
          )}

          {message && phase !== "error" && (
            <p className="authorize-message" role="alert">
              <CircleAlert size={15} strokeWidth={1.9} aria-hidden="true" />
              {message}
            </p>
          )}
        </motion.div>
      </main>

      <footer className="site-footer">
        <p>© {new Date().getFullYear()} Hook</p>
        <nav aria-label="Legal and contact">
          <a href="/privacy" target="_blank" rel="noopener">
            Privacy
          </a>
          <span aria-hidden="true">·</span>
          <a href="/terms" target="_blank" rel="noopener">
            Terms
          </a>
        </nav>
      </footer>
    </div>
  );
}
