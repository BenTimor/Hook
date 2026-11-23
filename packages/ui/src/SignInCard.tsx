import { ArrowRight, ExternalLink, LogIn, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { HookMark } from "./HookMark";

/**
 * Signing in, everywhere.
 *
 * The chat window, Hook Workspace, the phone and the browser all stand in front
 * of the same account, and all four show the same three states: checking the
 * stored session, idle, and waiting for the device flow to be approved. The copy
 * and the buttons live here so the four cannot drift apart — a host passes its
 * shell, its sentence about what the account unlocks, and the two calls only it
 * knows how to make.
 *
 * `surface` draws the card's own panel, for a host that has a page around it
 * (Workspace, the phone, a browser tab). The chat window's sign-in *is* the whole
 * window, so it passes `false` and keeps its own background.
 */
export type SignInState = "checking" | "idle" | "pending";

export type SignInCardProps = {
  state: SignInState;
  /** The code the person types in the browser while `state` is `pending`. */
  code?: string;
  busy?: boolean;
  /** A refusal worth its own line, not a toast: this screen is on top. */
  error?: string;
  surface?: boolean;

  kicker?: string;
  title?: string;
  copy?: ReactNode;
  /** The idle button. A phone says "Continue with Google", a desktop "Sign in". */
  signInLabel?: string;
  signInIcon?: ReactNode;
  /** What to do while `pending`; the flow itself is already running. */
  hint?: string;

  onSignIn: () => void;
  /** Reopen the page the flow opened. `undefined` hides the button. */
  onOpenPage?: () => void;
  onCancel?: () => void;
  /** The second way in: a code instead of the account sheet, or the waitlist. */
  alternate?: { label: string; onClick: () => void };
  /** A host's own line under everything, which no other host can write. */
  note?: ReactNode;
};

export function SignInCard({
  state,
  code,
  busy = false,
  error,
  surface = true,
  kicker,
  title,
  copy,
  signInLabel = "Continue with Google",
  signInIcon,
  hint,
  onSignIn,
  onOpenPage,
  onCancel,
  alternate,
  note,
}: SignInCardProps) {
  return (
    <section className="signin-card" data-surface={surface} aria-live="polite">
      <div className="signin-mark" aria-hidden="true">
        <HookMark />
      </div>

      {state === "checking" ? (
        <>
          <p className="signin-kicker">{kicker ?? "One moment"}</p>
          <h1 className="signin-title">{title ?? "Checking your account…"}</h1>
          <span className="signin-spinner" aria-hidden="true" />
        </>
      ) : state === "pending" ? (
        <>
          <p className="signin-kicker">{kicker ?? "Almost there"}</p>
          <h1 className="signin-title">
            {title ?? "Approve Hook in your browser."}
          </h1>
          <p className="signin-copy">
            {copy ??
              "We opened hookcode.io. Sign in with Google, check that the code matches, and approve this device."}
          </p>
          <code className="signin-code">{code ?? "—"}</code>
          <p className="signin-hint">
            {hint ?? "This window finishes by itself as soon as you approve."}
          </p>
          <div className="signin-actions">
            {onOpenPage && (
              <button className="signin-primary" onClick={onOpenPage}>
                <ExternalLink size={16} strokeWidth={1.9} />
                Open the page again
              </button>
            )}
            {onCancel && (
              <button className="signin-secondary" onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
          <span className="signin-waiting">
            <i aria-hidden="true" />
            Waiting for approval
          </span>
        </>
      ) : (
        <>
          <p className="signin-kicker">{kicker ?? "Welcome to Hook"}</p>
          <h1 className="signin-title">{title ?? "Sign in to get started."}</h1>
          <p className="signin-copy">
            {copy ??
              "Hook is invite-only for now. Use the same Google account you joined the waiting list with — once you’re approved, chat and coding agents unlock together."}
          </p>
          <button
            className="signin-primary"
            onClick={onSignIn}
            disabled={busy}
            aria-busy={busy}
          >
            {signInIcon ?? <LogIn size={17} strokeWidth={1.9} />}
            {busy ? "Opening your browser…" : signInLabel}
          </button>
          {alternate && (
            <button className="signin-link" onClick={alternate.onClick}>
              {alternate.label}
              <ArrowRight size={14} strokeWidth={1.9} />
            </button>
          )}
          <p className="signin-privacy">
            <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
            Your Google password never touches Hook. We only receive your name
            and email.
          </p>
        </>
      )}

      {error && (
        <p className="signin-error" role="alert">
          {error}
        </p>
      )}
      {note}
    </section>
  );
}
