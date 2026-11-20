import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";

import { HookMark } from "@hook/ui";

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
 * A desktop has no such sheet, and a phone whose server has no Google
 * credentials has nothing to ask, so the device flow stays behind "Use a code
 * instead": ask for a code, open the browser, poll. That path is the one the
 * desktop uses, which is why there is only one of it.
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
  const [byCode, setByCode] = useState(false);
  const pending = auth?.state === "pending";

  useEffect(() => {
    // The button exists only when both halves do: a device with an account
    // sheet, and a server that can check the token it returns. Half of one is a
    // dead end, so it falls back to the code.
    void Promise.all([mobile.googleAvailable(), mobile.googleClientId()])
      .then(([sheet, clientId]) => setGoogle(Boolean(sheet && clientId)))
      .catch(() => setGoogle(false));
  }, []);

  const useCode = () => {
    setByCode(true);
    // `auth_login` opens the browser itself; it runs on this tap and not on
    // mount, so the app is never pushed into the background before the person
    // has asked for anything.
    void signIn();
  };

  return (
    <section className="screen signin">
      <div className="signin-card">
        <div className="signin-mark">
          <HookMark />
        </div>
        <h1>Hook</h1>
        <p className="signin-copy">
          Sign in with the account you already use. Your conversations and your
          Workspace follow you; nothing is installed twice.
        </p>

        {pending ? (
          <>
            <div className="device-code" aria-label="Sign-in code">
              {auth?.userCode ?? "—"}
            </div>
            <button
              className="btn btn-primary signin-open"
              onClick={() => {
                if (auth?.verificationUrl) void mobile.openUrl(auth.verificationUrl);
              }}
            >
              Open the sign-in page
              <ArrowUpRight strokeWidth={1.9} />
            </button>
            <button className="btn signin-cancel" onClick={() => void cancel()}>
              Cancel
            </button>
            <p className="signin-wait">
              Waiting for the browser. This screen finishes on its own — come
              back to it after signing in.
            </p>
          </>
        ) : byCode ? (
          <button className="btn btn-primary signin-open" onClick={useCode}>
            Get a sign-in code
            <ArrowUpRight strokeWidth={1.9} />
          </button>
        ) : (
          <>
            {google ? (
              <button
                className="btn btn-primary signin-open"
                onClick={() => void signInWithGoogle()}
              >
                Continue with Google
              </button>
            ) : (
              <button className="btn btn-primary signin-open" onClick={useCode}>
                Sign in
                <ArrowUpRight strokeWidth={1.9} />
              </button>
            )}
            {google ? (
              <button className="btn signin-cancel" onClick={useCode}>
                Use a code instead
              </button>
            ) : null}
          </>
        )}

        {auth?.message ? <p className="signin-error">{auth.message}</p> : null}
        {error ? <p className="signin-error">{error}</p> : null}
      </div>
    </section>
  );
}
