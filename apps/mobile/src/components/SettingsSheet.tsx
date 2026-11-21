import { useEffect, useState } from "react";
import { CloudOff, KeyRound, LogOut, X } from "lucide-react";

import { mobile } from "../lib/api";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import type { CustomProvider } from "../lib/types";
import { useMobileChat } from "../store/useMobileChat";

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

/**
 * The phone's own model endpoint.
 *
 * Per product on purpose: this key lives in this app's container, is read by
 * nobody else, and is never part of the account or its sync. A free account
 * that saves one gets coding agents (on the desktop) and is no longer metered
 * by Hook, which is why the form sits right under the plan row.
 */
function ProviderForm({ saved }: { saved: CustomProvider | null }) {
  const saveProvider = useMobileChat((s) => s.saveCustomProvider);
  const clearProvider = useMobileChat((s) => s.clearCustomProvider);
  const plan = useMobileChat((s) => s.settings?.plan);
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(saved?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(saved?.baseUrl ?? "");
    setModel(saved?.model ?? "");
    // Never read the stored key back: an empty field keeps what is saved.
    setApiKey("");
    setModels([]);
  }, [saved?.baseUrl, saved?.model]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-block">
      <div className="settings-label">
        <span>Model access</span>
        <span className="settings-tag">{saved ? "Your provider" : "Hook’s models"}</span>
      </div>
      <p className="settings-help">
        Use your own OpenAI-compatible endpoint instead of Hook’s models; it must
        speak the chat-completions API including tool calling. The key is stored
        in this app on this phone, sent only to the endpoint you enter, and never
        uploaded, synced or shared with us. The desktop and Hook
        Workspace keep their own — set it there too if you want it.
      </p>
      {plan === "free" && (
        <p className="settings-help">
          On the free plan, using your own endpoint lifts Hook's 100-message
          limit. Requests to your provider are not metered by Hook.
        </p>
      )}
      <label className="phone-field">
        <span>Endpoint</span>
        <input
          className="phone-input"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <label className="phone-field">
        <span>API key</span>
        <input
          className="phone-input"
          type="password"
          spellCheck={false}
          autoComplete="off"
          placeholder={saved?.hasKey ? "Saved — leave blank to keep it" : "sk-…"}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      <label className="phone-field">
        <span>Model</span>
        <input
          className="phone-input"
          spellCheck={false}
          autoComplete="off"
          list="hook-phone-models"
          placeholder="gpt-4o-mini"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
        <datalist id="hook-phone-models">
          {models.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>
      <div className="phone-actions">
        <button
          className="btn"
          disabled={busy || !baseUrl.trim()}
          onClick={() =>
            void run(async () => {
              const list = await mobile.customModels(baseUrl, apiKey);
              setModels(list);
              setNotice(
                list.length
                  ? `${list.length} models found. Pick one or type another.`
                  : "No models came back. Type the name instead.",
              );
            })
          }
        >
          {busy ? "Working…" : "Load models"}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !baseUrl.trim() || !model.trim()}
          onClick={() =>
            void run(async () => {
              await saveProvider(baseUrl, apiKey, model);
              setApiKey("");
              setNotice("Saved. New messages use this endpoint.");
            })
          }
        >
          <KeyRound strokeWidth={1.9} />
          {saved ? "Save" : "Use it"}
        </button>
        {saved && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await clearProvider();
                setNotice("Removed. Hook’s own models are used again.");
              })
            }
          >
            Remove
          </button>
        )}
      </div>
      {error && <p className="settings-help bad">{error}</p>}
      {notice && <p className="settings-help">{notice}</p>}
    </div>
  );
}

/**
 * Settings, as a sheet.
 *
 * A phone has one account, a plan, the account-wide sync switch, its own model
 * endpoint and the switch that changes how a reply is drawn. Everything else the
 * desktop's sheet holds — projects folder, updates, import — belongs to a
 * machine that owns files, and this one does not.
 */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const auth = useMobileChat((s) => s.auth);
  const settings = useMobileChat((s) => s.settings);
  const sync = useMobileChat((s) => s.sync);
  const setAdvanced = useMobileChat((s) => s.setAdvanced);
  const setCloudSync = useMobileChat((s) => s.setCloudSync);
  const refreshSync = useMobileChat((s) => s.refreshSync);
  const refreshAuth = useMobileChat((s) => s.refreshAuth);
  const signOut = useMobileChat((s) => s.signOut);
  const [version, setVersion] = useState("");

  useBackHandler(BACK_LAYER.sheet, true, onClose);

  useEffect(() => {
    void mobile.appInfo().then((info) => setVersion(info.version)).catch(() => undefined);
    void refreshSync();
    // The plan and the free window are account state; ask before drawing them.
    void refreshAuth();
  }, [refreshSync, refreshAuth]);

  const free = settings?.plan === "free";
  const quota = auth?.quota;
  const used = quota?.used ?? 0;
  const limit = quota?.limit ?? 100;
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div
        className="sheet sheet-tall"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <div className="sheet-heading">
            <div className="sheet-title">Settings</div>
            <div className="sheet-note">{auth?.email ?? "Signed out"}</div>
          </div>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <X strokeWidth={2} />
          </button>
        </header>

        <div className="sheet-body settings">
          <div className="settings-block">
            <div className="settings-label">
              <span>Plan</span>
              <span className="settings-tag">{planName(settings?.plan)}</span>
            </div>
            {free && settings?.customProvider ? (
              <p className="settings-help">
                Your own model provider is in use, so Hook's 100-message limit does
                not apply on this phone. Cloud sync is still part of a paid plan.
              </p>
            ) : free ? (
              <>
                <div className="phone-quota-head">
                  <strong>
                    {used} of {limit}
                  </strong>
                  <span>messages in the last 24 hours</span>
                </div>
                <div className="phone-quota" aria-hidden="true">
                  <span data-full={used >= limit} style={{ width: `${percent}%` }} />
                </div>
                <p className="settings-help">
                  The free plan keeps your conversations on this phone and does not
                  include coding agents. Hook’s model service counts messages; add
                  your own endpoint below to use it without that limit.
                </p>
              </>
            ) : (
              <p className="settings-help">
                Cloud sync and coding agents are included. Hook’s model service has
                no daily message limit on this plan.
              </p>
            )}
          </div>

          <ProviderForm saved={settings?.customProvider ?? null} />

          <div className="settings-block">
            <div className="settings-label">
              <span>Cloud sync</span>
              {free ? <CloudOff strokeWidth={1.8} /> : null}
            </div>
            {free ? (
              <p className="settings-help">
                Cloud sync is part of a paid plan. Your chats stay on this phone;
                the list marks each one that is not in the cloud.
              </p>
            ) : (
              <>
                <label className="setting-row">
                  <span className="setting-copy">
                    <strong>Sync my chats to the cloud</strong>
                    <em>
                      {settings?.cloudSync === false
                        ? "Off — new changes stay on this phone."
                        : sync?.message ??
                          (sync?.state === "syncing"
                            ? "Syncing…"
                            : `${sync?.cursor ?? 0} changes up to date`)}
                    </em>
                  </span>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={settings?.cloudSync !== false}
                    onChange={(event) => void setCloudSync(event.target.checked)}
                  />
                </label>
                <p className="settings-help">
                  The switch belongs to the account, so turning it off here also
                  turns it off on your computers.
                </p>
              </>
            )}
          </div>

          <label className="setting-row">
            <span className="setting-copy">
              <strong>Advanced mode</strong>
              <em>Show what the agent thought and which tools it used.</em>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={Boolean(settings?.advancedMode)}
              onChange={(event) => void setAdvanced(event.target.checked)}
            />
          </label>

          <div className="setting-row setting-static">
            <span className="setting-copy">
              <strong>Version</strong>
              <em>{version || "—"}</em>
            </span>
          </div>

          <button
            className="btn btn-danger setting-signout"
            onClick={() => {
              void signOut();
              onClose();
            }}
          >
            <LogOut strokeWidth={1.8} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
