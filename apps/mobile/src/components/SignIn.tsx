import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";

import { SignInCard } from "@hook/ui";

import { mobile } from "../lib/api";
import { useMobileChat } from "../store/useMobileChat";

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
        kicker={pending ? "Almost there" : "Hook for phones"}
        title={
          pending ? "Approve Hook in your browser." : "Sign in to get started."
        }
        copy={
          pending
            ? "Open the page, sign in with Google, and check that the code matches. This screen finishes on its own."
            : "Your conversations and your Workspace follow you; nothing is installed twice."
        }
        signInLabel={google ? "Continue with Google" : "Sign in"}
        signInIcon={google ? undefined : <ArrowUpRight size={17} strokeWidth={1.9} />}
        hint="Waiting for the browser. Come back to this screen after signing in."
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
