import { openExternal } from "../lib/bridge";
import { useChatStore } from "../store/useChatStore";
import { HookMark, SignInCard, WindowControls } from "@hook/ui";

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
        <SignInCard
          surface={false}
          state={checking ? "checking" : pending ? "pending" : "idle"}
          code={auth?.state === "pending" ? (auth.userCode ?? undefined) : undefined}
          busy={busy}
          error={error ?? undefined}
          hint="This window finishes by itself as soon as you approve."
          onSignIn={() => void signIn()}
          onOpenPage={
            pending && auth.verificationUrl
              ? () => void openExternal(auth.verificationUrl!)
              : undefined
          }
          onCancel={() => void cancel()}
          alternate={{
            label: "Join the waiting list",
            onClick: () => void openExternal("https://hookcode.io/"),
          }}
        />
      </main>

      <footer className="login-foot">
        <span>Hook · early access</span>
        <span>hookcode.io</span>
      </footer>
    </div>
  );
}
