import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";

import { SignInCard } from "@hook/ui";

import { mobile } from "../lib/api";
import { useMobileChat } from "../store/useMobileChat";
import { SignInHero } from "./SignInHero";

/**
 * Signing in on a phone.
 *
 * The default is the phone's own account sheet: tap, pick the Google account
 * already on the device, done. The ID token goes to the server, which decides
 * whether it belongs to an approved account — there is no browser and nothing
 * to come back to.
 *
 * A phone whose server has no Google credentials has nothing to ask, so the
 * device flow stays behind "Use a code instead": ask for a code, open the
 * browser, poll. That path is the one the desktop uses, which is why there is
 * only one of it.
 *
 * The card itself is `packages/ui`'s: the four sign-in screens are one screen
 * with a different sentence on top, and this file is the phone's sentence and
 * its two calls.
 */
export function SignIn() {
  const auth = useMobileChat((s) => s.auth);
  const signIn = useMobileChat((s) => s.signIn);
  const signInWithGoogle = useMobileChat((s) => s.signInWithGoogle);
  const cancel = useMobileChat((s) => s.cancelSignIn);
  // A failed sign-in is exactly the moment the reason matters most, and this
  // screen is what is on top when it happens.
  const error = useMobileChat((s) => s.error);

  const [google, setGoogle] = useState(false);
  const pending = auth?.state === "pending";

  useEffect(() => {
    // The button exists only when both halves do: a device with an account
    // sheet, and a server that can check the token it returns. Half of one is a
    // dead end, so it falls back to the code.
    void Promise.all([mobile.googleAvailable(), mobile.googleClientId()])
      .then(([sheet, clientId]) => setGoogle(Boolean(sheet && clientId)))
      .catch(() => setGoogle(false));
  }, []);

  useEffect(() => {
    // The hero runs under the native status bar, so its icons have to be light
    // here and dark again on the beige screens behind this one.
    void mobile.setStatusBarStyle("light");
    return () => {
      void mobile.setStatusBarStyle("dark");
    };
  }, []);

  // `auth_login` opens the browser itself; it runs on this tap and not on
  // mount, so the app is never pushed into the background before the person
  // has asked for anything.
  const useCode = () => void signIn();

  return (
    <section className="screen signin">
      <SignInCard
        state={pending ? "pending" : auth ? "idle" : "checking"}
        code={pending ? (auth?.userCode ?? undefined) : undefined}
        error={auth?.message ?? error ?? undefined}
        surface={false}
        hero={<SignInHero />}
        kicker={pending ? "Almost there" : null}
        title={
          pending ? (
            "Approve Hook in your browser."
          ) : (
            <>
              <span className="signin-title-line">Hook,</span>
              <span className="signin-title-line signin-title-accent">
                in your pocket.
              </span>
            </>
          )
        }
        copy={
          pending
            ? "Open the page, sign in with Google, and check that the code matches. This screen finishes on its own."
            : "Everything you started, ready to continue."
        }
        signInLabel={google ? "Continue with Google" : "Sign in"}
        signInIcon={google ? undefined : <ArrowUpRight size={17} strokeWidth={1.9} />}
        secondaryAction={
          <button
            type="button"
            className="signin-apple"
            data-prototype="true"
            aria-disabled="true"
            title="Prototype only — Apple sign-in is not implemented yet."
            onClick={(event) => event.preventDefault()}
          >
            <span className="signin-apple-icon" aria-hidden="true">
              <AppleMark />
            </span>
            <span className="signin-apple-label">Sign in with Apple</span>
            <span className="signin-apple-badge">Preview</span>
          </button>
        }
        hint="Waiting for the browser. Come back to this screen after signing in."
        privacy="Secure Google sign-in. No passwords shared."
        onSignIn={() => void (google ? signInWithGoogle() : useCode())}
        onOpenPage={
          pending && auth?.verificationUrl
            ? () => {
                if (auth?.verificationUrl) void mobile.openUrl(auth.verificationUrl);
              }
            : undefined
        }
        onCancel={pending ? () => void cancel() : undefined}
        alternate={
          google && !pending
            ? { label: "Use a code instead", onClick: useCode }
            : undefined
        }
      />
    </section>
  );
}

/**
 * The Apple mark, only for the clearly-labelled visual prototype. This button
 * has no authentication behind it; a real Sign in with Apple flow can replace
 * the element passed as `secondaryAction` without touching layout.
 */
function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" focusable="false">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.702" />
    </svg>
  );
}
