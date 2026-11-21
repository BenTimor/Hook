import { useChatStore } from "../store/useChatStore";

/**
 * The free plan's 24-hour window, when it has run out.
 *
 * The backend refuses the message anyway; this is the sentence above the box
 * so the refusal does not arrive as a red toast after a send that looked fine.
 * A personal model endpoint has no Hook limit at all, so the notice disappears
 * the moment one is saved.
 */
export function FreeLimitNotice() {
  const auth = useChatStore((s) => s.auth);
  const settings = useChatStore((s) => s.settings);
  const openSettings = useChatStore((s) => s.openSettings);

  const quota = auth?.quota;
  if (
    settings?.plan !== "free" ||
    settings?.customProvider ||
    !quota ||
    quota.used < quota.limit
  ) {
    return null;
  }

  return (
    <div className="limit-notice" role="status">
      <span>
        You have used this day's {quota.limit} free messages. Add your own model
        provider to keep going without a limit, or upgrade your plan.
      </span>
      <button className="btn btn-ghost" onClick={() => void openSettings()}>
        Settings
      </button>
    </div>
  );
}
