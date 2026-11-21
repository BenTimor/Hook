import { useEffect, useState } from "react";
import { Cloud, CloudOff, KeyRound } from "lucide-react";

import { Dialog } from "@hook/ui";

import { api, openExternal, type AuthView, type SettingsView, type SyncView } from "../lib/bridge";

function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function planName(plan: string | null | undefined): string {
  if (plan === "free") return "Free";
  if (plan === "plus") return "Hook Plus";
  if (plan === "pro") return "Hook Pro";
  return "Preview";
}

function untilReset(iso: string | null | undefined): string {
  if (!iso) return "soon";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.ceil(minutes / 60)}h`;
}

/**
 * The account, the plan and this product's own model endpoint.
 *
 * Hook Workspace shares the account, the conversations and the cloud-sync
 * switch with the chat app, but not the endpoint: a key belongs to the product
 * whose folder holds it, and this dialog is where this one's is entered. The
 * dialog only covers the chat side of Workspace — projects, boards and tasks
 * are the product itself and need no switch.
 */
export function WorkspaceSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [auth, setAuth] = useState<AuthView | null>(null);
  const [sync, setSync] = useState<SyncView | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"load" | "save" | "remove" | "sync" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    setNotice(null);
    setApiKey("");
    setModels([]);
    void Promise.all([api.getSettings(), api.authRefresh(), api.syncStatus()])
      .then(([nextSettings, nextAuth, nextSync]) => {
        if (!alive) return;
        setSettings(nextSettings);
        setAuth(nextAuth);
        setSync(nextSync);
        setBaseUrl(nextSettings.customProvider?.baseUrl ?? "");
        setModel(nextSettings.customProvider?.model ?? "");
      })
      .catch((caught) => {
        if (alive) setError(textOf(caught));
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const free = settings?.plan === "free";
  const quota = auth?.quota ?? null;
  const used = quota?.used ?? 0;
  const limit = quota?.limit ?? 100;
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));

  const saveProvider = async () => {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const next = await api.setCustomProvider(baseUrl, apiKey, model);
      setSettings(next);
      setApiKey("");
      setNotice("Saved on this computer. The next message uses it.");
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const syncOff = settings?.cloudSync === false;

  return (
    <Dialog
      open={open}
      title="Settings"
      description={auth?.email ?? "Signed in to Hook"}
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="ws-settings">
        <section className="ws-settings-block">
          <div className="ws-settings-label">
            <span>Plan</span>
            <span className="ws-plan-pill" data-plan={settings?.plan ?? "preview"}>
              {planName(settings?.plan)}
            </span>
          </div>
          {free && settings?.customProvider ? (
            <p className="ws-settings-help">
              Your own model provider is in use, so Hook's 100-message limit does
              not apply on this product. Cloud sync is still part of a paid plan.
            </p>
          ) : free ? (
            <>
              <div className="ws-quota-head">
                <strong>
                  {used} of {limit}
                </strong>
                <span>messages in the last 24 hours</span>
              </div>
              <div className="ws-quota" aria-hidden="true">
                <span data-full={used >= limit} style={{ width: `${percent}%` }} />
              </div>
              <p className="ws-settings-help">
                The free plan keeps conversations on each computer and does not
                include coding agents. Hook's model service counts messages; add
                your own endpoint below to use it without that limit.
                {used === 0
                  ? " Nothing counted in this window yet."
                  : ` It frees up ${untilReset(quota?.resetAt)}.`}{" "}
                <button
                  className="inline-link"
                  onClick={() => void openExternal("https://hookcode.io/")}
                >
                  See paid plans
                </button>
                .
              </p>
            </>
          ) : (
            <p className="ws-settings-help">
              Cloud sync and coding agents are included, with no daily message
              limit from Hook's model service.
            </p>
          )}
        </section>

        <section className="ws-settings-block">
          <div className="ws-settings-label">
            <span>Model access</span>
            <span className="ws-settings-tag">
              {settings?.customProvider ? "Your provider" : "Hook's models"}
            </span>
          </div>
          <p className="ws-settings-help">
            Use your own OpenAI-compatible endpoint instead of Hook's models; it
            must speak the chat-completions API including tool calling. The key is
            saved in this product's folder on this computer, sent only to the
            endpoint you enter, and never uploaded or synced. Hook and HookCode
            keep their own.
            {free
              ? " On the free plan this also lifts the 100-message limit and lets the desktop app start coding agents; Hook does not meter requests that go to your provider."
              : ""}
          </p>
          <label className="ws-settings-field">
            <span>Endpoint</span>
            <input
              className="text-input"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://api.openai.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label className="ws-settings-field">
            <span>API key</span>
            <input
              className="text-input"
              type="password"
              spellCheck={false}
              autoComplete="off"
              placeholder={
                settings?.customProvider?.hasKey
                  ? "Saved — leave blank to keep it"
                  : "sk-…"
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <label className="ws-settings-field">
            <span>Model</span>
            <input
              className="text-input"
              spellCheck={false}
              autoComplete="off"
              list="ws-custom-models"
              placeholder="gpt-4o-mini"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="ws-custom-models">
              {models.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <div className="ws-settings-actions">
            <button
              className="btn"
              disabled={busy !== null || !baseUrl.trim()}
              onClick={() => {
                setBusy("load");
                setError(null);
                setNotice(null);
                void api
                  .customModels(baseUrl, apiKey)
                  .then((list) => {
                    setModels(list);
                    setNotice(
                      list.length
                        ? `${list.length} models found. Pick one or type another.`
                        : "No models came back. Type the name instead.",
                    );
                  })
                  .catch((caught) => setError(textOf(caught)))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === "load" ? "Loading…" : "Load models"}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy !== null || !baseUrl.trim() || !model.trim()}
              onClick={() => void saveProvider()}
            >
              <KeyRound strokeWidth={1.9} />
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            {settings?.customProvider ? (
              <button
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() => {
                  setBusy("remove");
                  setError(null);
                  setNotice(null);
                  void api
                    .clearCustomProvider()
                    .then((next) => {
                      setSettings(next);
                      setNotice("Removed. Hook's own models are used again.");
                    })
                    .catch((caught) => setError(textOf(caught)))
                    .finally(() => setBusy(null));
                }}
              >
                Remove
              </button>
            ) : null}
          </div>
          {error ? <p className="ws-settings-help bad">{error}</p> : null}
          {notice ? <p className="ws-settings-help">{notice}</p> : null}
        </section>

        <section className="ws-settings-block">
          <div className="ws-settings-label">
            <span>Cloud sync</span>
            {free || !sync?.enabled ? <CloudOff strokeWidth={1.8} /> : <Cloud strokeWidth={1.8} />}
          </div>
          {free ? (
            <p className="ws-settings-help">
              Cloud sync is part of a paid plan. Conversations started in Hook
              Workspace stay on this computer, and Hook marks them as not in the
              cloud.
            </p>
          ) : (
            <>
              <label className="ws-settings-check">
                <input
                  type="checkbox"
                  checked={!syncOff}
                  disabled={busy !== null}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setBusy("sync");
                    setError(null);
                    void api
                      .setCloudSync(enabled)
                      .then(async (next) => {
                        setSettings(next);
                        setSync(await api.syncStatus());
                      })
                      .catch((caught) => setError(textOf(caught)))
                      .finally(() => setBusy(null));
                  }}
                />
                Sync my chats to the cloud
              </label>
              <p className="ws-settings-help">
                The switch belongs to the account, so it applies to Hook and
                HookCode too. When it is off, new conversations stay on this
                computer.
                {sync?.state === "syncing" ? " Saving your latest changes…" : ""}
              </p>
            </>
          )}
        </section>
      </div>
    </Dialog>
  );
}
