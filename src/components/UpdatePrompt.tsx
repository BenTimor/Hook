import { ArrowUpCircle, Loader2, X } from "lucide-react";

import { useChatStore } from "../store/useChatStore";
import { useUpdateStore } from "../store/useUpdateStore";

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function UpdateProgress({
  received,
  total,
  size,
  phase,
}: {
  received: number;
  total: number | null;
  size: number | null;
  phase: "downloading" | "installing" | null;
}) {
  const bytes = total ?? size;
  const percent = bytes ? Math.min(100, Math.round((received / bytes) * 100)) : null;

  return (
    <div className="update-progress" role="status" aria-live="polite">
      <div className="update-progress-track">
        <span
          style={{ width: percent === null ? "30%" : `${percent}%` }}
          data-indeterminate={percent === null}
        />
      </div>
      <span className="update-progress-label">
        {phase === "installing"
          ? "Installing — Hook will restart in a moment."
          : percent === null
            ? "Downloading…"
            : `Downloading ${percent}%${bytes ? ` of ${formatSize(bytes)}` : ""}`}
      </span>
    </div>
  );
}

/**
 * One optional banner plus one blocking dialog, driven by the same check.
 * Required updates cannot be dismissed; optional ones can wait until next
 * launch (the banner stays gone for the session, the check runs again later).
 */
export function UpdatePrompt({ showBanner = true }: { showBanner?: boolean }) {
  const info = useUpdateStore((s) => s.info);
  const installing = useUpdateStore((s) => s.installing);
  const phase = useUpdateStore((s) => s.phase);
  const progress = useUpdateStore((s) => s.progress);
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const error = useUpdateStore((s) => s.error);
  const install = useUpdateStore((s) => s.install);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const signedIn = useChatStore((s) => Boolean(s.auth?.signedIn));
  const authBusy = useChatStore((s) => s.authBusy);
  const signIn = useChatStore((s) => s.signIn);

  if (!info?.available) return null;

  if (info.required || installing) {
    return (
      <div className="update-backdrop">
        <div
          className="update-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-title"
        >
          <span className="update-dialog-icon" aria-hidden="true">
            {installing ? (
              <Loader2 className="spin" strokeWidth={1.8} />
            ) : (
              <ArrowUpCircle strokeWidth={1.8} />
            )}
          </span>

          <div className="update-dialog-copy">
            <h2 id="update-title">
              {installing
                ? "Updating Hook"
                : info.required
                  ? "This version is out of date"
                  : `Hook ${info.latest} is ready`}
            </h2>
            <p>
              {installing
                ? "Hook downloads the new version, checks it, and restarts itself. Your chats stay on this machine."
                : info.required
                  ? `Hook ${info.minimum} is now the oldest supported version. Updating keeps your account, chats and projects exactly where they are.`
                  : `You're on ${info.current}. The new version is downloaded and installed here — no website, no manual setup.`}
            </p>
            {info.notes && !installing ? (
              <p className="update-dialog-notes">{info.notes}</p>
            ) : null}
          </div>

          {installing ? (
            <UpdateProgress
              received={progress?.received ?? 0}
              total={progress?.total ?? null}
              size={info.size}
              phase={phase}
            />
          ) : null}

          {error ? <p className="update-error">{error}</p> : null}

          {!installing ? (
            <div className="update-dialog-actions">
              {!signedIn ? (
                <>
                  <span className="update-reassure">
                    This update is required to keep using Hook.
                  </span>
                  <button
                    className="btn btn-primary"
                    onClick={() => void signIn()}
                    disabled={authBusy}
                  >
                    {authBusy ? "Waiting for approval…" : "Sign in to update"}
                  </button>
                </>
              ) : (
                <>
                  {info.required ? (
                    <span className="update-reassure">
                      This update is required to keep using Hook.
                    </span>
                  ) : (
                    <button className="btn" onClick={dismiss}>
                      Later
                    </button>
                  )}
                  <button
                    className="btn btn-primary"
                    onClick={() => void install()}
                  >
                    Update to {info.latest}
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (!showBanner || dismissedVersion === info.latest) return null;

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-icon" aria-hidden="true">
        <ArrowUpCircle strokeWidth={1.8} />
      </span>
      <div className="update-banner-copy">
        <strong>Hook {info.latest} is ready</strong>
        <span>
          {info.notes ?? `You're on ${info.current}.`}
          {info.size ? ` · ${formatSize(info.size)}` : ""}
        </span>
      </div>
      <button className="btn btn-primary" onClick={() => void install()}>
        Update now
      </button>
      <button className="icon-btn" onClick={dismiss} title="Later">
        <X strokeWidth={2} />
      </button>
    </div>
  );
}
