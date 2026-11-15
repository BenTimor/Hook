import { ArrowRight, ExternalLink, LogIn, ShieldCheck } from "lucide-react";

import { openExternal } from "../lib/bridge";
import { useChatStore } from "../store/useChatStore";
import { HookMark } from "./HookMark";
import { WindowControls } from "./WindowControls";

/**
 * The window before there is an account. Hook is invite-only: the download and
 * the model proxy only answer for approved waitlist members, so this screen is
 * the one place to link the desktop app to that account.
 */
export function LoginScreen({ maximized }: { maximized: boolean }) {
  const auth = useChatStore((s) => s.auth);
  const busy = useChatStore((s) => s.authBusy);
  const error = useChatStore((s) => s.authError);
  const signIn = useChatStore((s) => s.signIn);
  const cancel = useChatStore((s) => s.cancelSignIn);

  const pending = auth?.state === "pending";
  const checking = auth === null;

  return (
    <div className="login-screen" data-maximized={maximized}>
      <header className="login-head" data-tauri-drag-region>
        <div className="login-wordmark" data-tauri-drag-region>
          <HookMark />
          <span>Hook</span>
        </div>
        <WindowControls />
      </header>

      <main className="login-main">
        <section className="login-card" aria-live="polite">
          <div className="login-mark" aria-hidden="true">
            <HookMark />
          </div>

          {checking ? (
            <>
              <p className="login-kicker">One moment</p>
              <h1>Checking your account…</h1>
              <span className="login-spinner" aria-hidden="true" />
            </>
          ) : pending ? (
            <>
              <p className="login-kicker">Almost there</p>
              <h1>Approve Hook in your browser.</h1>
              <p className="login-copy">
                We opened hookcode.io. Sign in with Google, check that the code
                matches, and approve this device.
              </p>
              <code className="login-code">{auth.userCode}</code>
              <p className="login-hint">
                This window finishes by itself as soon as you approve.
              </p>
              <div className="login-actions">
                {auth.verificationUrl && (
                  <button
                    className="login-primary"
                    onClick={() => void openExternal(auth.verificationUrl!)}
                  >
                    <ExternalLink size={16} strokeWidth={1.9} />
                    Open the page again
                  </button>
                )}
                <button className="login-secondary" onClick={() => void cancel()}>
                  Cancel
                </button>
              </div>
              <span className="login-waiting">
                <i aria-hidden="true" />
                Waiting for approval
              </span>
            </>
          ) : (
            <>
              <p className="login-kicker">Welcome to Hook</p>
              <h1>Sign in to get started.</h1>
              <p className="login-copy">
                Hook is invite-only for now. Use the same Google account you
                joined the waiting list with — once you’re approved, chat and
                coding agents unlock together.
              </p>
              <button
                className="login-primary"
                onClick={() => void signIn()}
                disabled={busy}
                aria-busy={busy}
              >
                <LogIn size={17} strokeWidth={1.9} />
                {busy ? "Opening your browser…" : "Continue with Google"}
              </button>
              <button
                className="login-link"
                onClick={() => void openExternal("https://hookcode.io/")}
              >
                Join the waiting list
                <ArrowRight size={14} strokeWidth={1.9} />
              </button>
              <p className="login-privacy">
                <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
                Your Google password never touches Hook. We only receive your
                name and email.
              </p>
            </>
          )}

          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
        </section>
      </main>

      <footer className="login-foot">
        <span>Hook · early access</span>
        <span>hookcode.io</span>
      </footer>
    </div>
  );
}
