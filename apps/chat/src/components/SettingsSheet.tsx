import { useEffect, useState } from "react";
import {
  ArrowUpCircle,
  Check,
  Cloud,
  CloudOff,
  Cpu,
  FolderOpen,
  GitBranch,
  KeyRound,
  LogOut,
  RefreshCw,
  UserRound,
  X,
} from "lucide-react";

import { api, openExternal } from "../lib/bridge";
import { useChatStore } from "../store/useChatStore";
import { useUpdateStore } from "../store/useUpdateStore";
import { ImportSection } from "./ImportSection";
import { MemorySection } from "./MemorySection";
import { AboutSection } from "./AboutSection";
import { MachinesSection } from "@hook/chat";

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

/** "in 3h" / "in 12m" for the free message window. */
function untilReset(iso: string | null | undefined): string {
  if (!iso) return "soon";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return `in ${hours}h`;
}

/**
 * The account's plan and what it allows.
 *
 * A free account is not a degraded paid one: it keeps everything on this
 * computer and is limited through Hook's model service. Bringing a model
 * endpoint of your own is the way past that without paying, which is why the
 * upgrade row and the provider form sit next to each other.
 */
function PlanSection() {
  const settings = useChatStore((s) => s.settings);
  const auth = useChatStore((s) => s.auth);
  const free = settings?.plan === "free";
  const quota = auth?.quota;
  const used = quota?.used ?? 0;
  const limit = quota?.limit ?? 100;
  const percent = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const blocked = used >= limit;

  return (
    <section className="sheet-section">
      <div className="sheet-label">
        <span>Plan</span>
        <span className="plan-pill" data-plan={settings?.plan ?? "preview"}>
          {planName(settings?.plan)}
        </span>
      </div>

      {free && settings?.customProvider ? (
        <p className="sheet-help">
          Your own model provider is in use, so Hook's 100-message limit and the
          coding-agent restriction do not apply on this product. Cloud sync is
          still part of a paid plan.
        </p>
      ) : free ? (
        <>
          <div className="quota-head">
            <strong>
              {used} of {limit}
            </strong>
            <span className="muted">free messages in the last 24 hours</span>
          </div>
          <div className="quota-bar" aria-hidden="true">
            <span data-full={blocked} style={{ width: `${percent}%` }} />
          </div>
          <p className="sheet-help">
            {blocked
              ? `You have used this window's messages. It frees up ${untilReset(quota?.resetAt)}.`
              : used === 0
                ? "No messages counted in this window yet. Tool calls do not use extra."
                : `Counts messages you send; tool calls do not use extra. Frees up ${untilReset(quota?.resetAt)}.`}{" "}
            A free plan keeps your chats, projects and memories on this computer
            and does not include coding agents.
          </p>
          <div className="plan-actions">
            <button
              className="btn btn-primary"
              onClick={() => void openExternal("https://hookcode.io/")}
            >
              See paid plans
            </button>
            <span className="sheet-help">
              or add your own model provider below — it lifts the message limit and
              lets you run coding agents.
            </span>
          </div>
        </>
      ) : (
        <p className="sheet-help">
          Cloud sync and coding agents are included. Hook's model service has no
          daily message limit on this plan; usage is subject to the published
          plan policy.
        </p>
      )}
    </section>
  );
}

/**
 * The user's own OpenAI-compatible endpoint, for this product only.
 *
 * The key is written to this product's settings file on this computer and is
 * never part of the account, sync or a support request. Hook does not see the
 * requests either: the app talks to the endpoint directly, which is why a free
 * account with a provider is not metered.
 */
function ModelSection() {
  const settings = useChatStore((s) => s.settings);
  const saveProvider = useChatStore((s) => s.saveCustomProvider);
  const clearProvider = useChatStore((s) => s.clearCustomProvider);
  const saved = settings?.customProvider ?? null;

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"load" | "save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(saved?.baseUrl ?? "");
    setModel(saved?.model ?? "");
    // Never read the stored key back into the window: an empty field means
    // "keep the key already saved".
    setApiKey("");
    setModels([]);
  }, [saved?.baseUrl, saved?.model]);

  const loadModels = async () => {
    setBusy("load");
    setError(null);
    setNotice(null);
    try {
      const list = await api.customModels(baseUrl, apiKey);
      setModels(list);
      setNotice(
        list.length
          ? `${list.length} model${list.length === 1 ? "" : "s"} found. Pick one or type another.`
          : "The endpoint returned no models. Type the model name instead.",
      );
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      await saveProvider(baseUrl, apiKey, model);
      setApiKey("");
      setNotice("Saved. New messages and coding agents use this endpoint.");
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      await clearProvider();
      setNotice("Removed. Hook's own model service is used again.");
    } catch (caught) {
      setError(textOf(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sheet-section">
      <div className="sheet-label">
        <span>Model access</span>
        <span className="status" data-on={Boolean(saved)}>
          {saved ? (
            <>
              <Check strokeWidth={2.2} /> Your provider
            </>
          ) : (
            "Hook's models"
          )}
        </span>
      </div>

      <p className="sheet-help">
        Use your own OpenAI-compatible endpoint instead of Hook's models; it must
        speak the chat-completions API including tool calling. The key is saved
        in <code>settings.json</code> in this product's folder on this computer,
        sent only to the endpoint you enter, and never uploaded, synced or shared
        with us. Each Hook product keeps its own — set it again
        in Hook Workspace or HookCode if you want it there. Removing it goes back
        to Hook's models.
      </p>
      {settings?.plan === "free" && (
        <p className="sheet-help">
          On the free plan, using your own endpoint also lifts the 100-message
          limit and lets you start coding agents. Hook does not meter requests
          that go to your provider.
        </p>
      )}

      <div className="provider-form">
        <label className="provider-field">
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
        <label className="provider-field">
          <span>API key</span>
          <input
            className="text-input"
            type="password"
            spellCheck={false}
            autoComplete="off"
            placeholder={saved?.hasKey ? "Saved — leave blank to keep it" : "sk-…"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label className="provider-field">
          <span>Model</span>
          <input
            className="text-input"
            spellCheck={false}
            autoComplete="off"
            list="hook-custom-models"
            placeholder="gpt-4o-mini"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id="hook-custom-models">
            {models.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <div className="path-row">
          <button
            className="btn"
            onClick={() => void loadModels()}
            disabled={busy !== null || !baseUrl.trim()}
            title="Ask the endpoint for its model list"
          >
            <Cpu strokeWidth={1.9} />
            {busy === "load" ? "Loading…" : "Load models"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={busy !== null || !baseUrl.trim() || !model.trim()}
          >
            <KeyRound strokeWidth={1.9} />
            {busy === "save" ? "Saving…" : saved ? "Save changes" : "Use this endpoint"}
          </button>
          {saved && (
            <button
              className="btn btn-ghost"
              onClick={() => void remove()}
              disabled={busy !== null}
              title="Go back to Hook's models"
            >
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="sheet-help bad">{error}</p>}
      {notice && <p className="sheet-help">{notice}</p>}
      {saved && (
        <p className="sheet-help">
          Talking to <code>{saved.model}</code> at <code>{saved.baseUrl}</code>.
          Coding agents use the same endpoint.
        </p>
      )}
    </section>
  );
}

/**
 * Cloud sync: the account's switch and its live state.
 *
 * The switch is stored on the account, not in this product, so turning it off
 * here turns it off in Hook Workspace and on the phone too. A free account has
 * no switch at all — there is nothing to turn on.
 */
function SyncControl() {
  const settings = useChatStore((s) => s.settings);
  const sync = useChatStore((s) => s.sync);
  const setCloudSync = useChatStore((s) => s.setCloudSync);
  const refreshSync = useChatStore((s) => s.refreshSync);
  const free = settings?.plan === "free";

  useEffect(() => {
    if (free) return;
    void refreshSync();
    const timer = window.setInterval(() => void refreshSync(), 5000);
    return () => window.clearInterval(timer);
  }, [free, refreshSync]);

  if (free) {
    return (
      <p className="sheet-help">
        Cloud sync is part of a paid plan. Your conversations, projects,
        memories and pictures stay on this computer, and the sidebar marks every
        chat that is not in the cloud.
      </p>
    );
  }

  if (sync && !sync.available) {
    return (
      <p className="sheet-help">
        This build has no account service, so nothing is synced anywhere.
      </p>
    );
  }

  const enabled = settings?.cloudSync ?? true;
  const title =
    !enabled
      ? "Sync is off"
      : sync?.state === "syncing"
        ? "Saving your latest changes…"
        : sync?.state === "error"
          ? "Sync is paused"
          : "Saved to your account";

  return (
    <>
      <label className="memory-note advanced-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => void setCloudSync(event.target.checked)}
        />
        Sync my chats to the cloud
      </label>
      <p className="sheet-help">
        On: your chats, projects, memories and pictures are available on every
        computer signed in to this account. Off: new changes stay on this
        computer, and every chat that is not in the cloud is marked in the
        sidebar. This switch belongs to the account, so it applies to every Hook
        product.
      </p>
      {enabled && (
        <div className="account-row">
          <span className="account-badge" aria-hidden="true">
            <Cloud strokeWidth={1.8} />
          </span>
          <div className="account-identity">
            <strong>{title}</strong>
            <span>
              {sync?.message ??
                (sync?.pending
                  ? `${sync.pending} change${sync.pending === 1 ? "" : "s"} waiting`
                  : "Nothing is waiting to be uploaded.")}
            </span>
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => void api.syncNow()}
            disabled={sync?.state === "syncing"}
            title="Sync now"
          >
            <RefreshCw strokeWidth={1.9} />
            Sync now
          </button>
        </div>
      )}
    </>
  );
}

export function SettingsSheet() {
  const open = useChatStore((s) => s.settingsOpen);
  const close = useChatStore((s) => s.closeSettings);
  const settings = useChatStore((s) => s.settings);
  const chooseProjectsDir = useChatStore((s) => s.chooseProjectsDir);
  const setAdvancedMode = useChatStore((s) => s.setAdvancedMode);
  const devices = useChatStore((s) => s.devices);
  const renameDevice = useChatStore((s) => s.renameDevice);
  const setDeviceRemote = useChatStore((s) => s.setDeviceRemote);
  const removeDevice = useChatStore((s) => s.removeDevice);
  const auth = useChatStore((s) => s.auth);
  const authBusy = useChatStore((s) => s.authBusy);
  const signOut = useChatStore((s) => s.signOut);
  const version = useChatStore((s) => s.info?.version);
  const update = useUpdateStore((s) => s.info);
  const checking = useUpdateStore((s) => s.checking);
  const installing = useUpdateStore((s) => s.installing);
  const closing = useUpdateStore((s) => s.closing);
  const checkUpdate = useUpdateStore((s) => s.check);
  const installUpdate = useUpdateStore((s) => s.install);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className="sheet-backdrop" onMouseDown={close}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={close} title="Close">
            <X strokeWidth={2} />
          </button>
        </div>

        <div className="sheet-body">
          <section className="sheet-section">
            <div className="sheet-label">
              <span>Account</span>
            </div>
            <div className="account-row">
              <span className="account-badge" aria-hidden="true">
                <UserRound strokeWidth={1.8} />
              </span>
              <div className="account-identity">
                <strong>{auth?.name || "Signed in"}</strong>
                <span>{auth?.email}</span>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => void signOut()}
                disabled={authBusy}
                title="Sign out"
              >
                <LogOut strokeWidth={1.9} />
                {authBusy ? "Signing out…" : "Sign out"}
              </button>
            </div>
            <p className="sheet-help">
              Chat and coding agents use this account.{" "}
              <button
                className="inline-link"
                onClick={() => void openExternal("https://hookcode.io/")}
              >
                Manage access on hookcode.io
              </button>
              .
            </p>
          </section>

          <PlanSection />

          <ModelSection />

          <ImportSection />

          <section className="sheet-section">
            <div className="sheet-label">
              <span>Advanced</span>
            </div>
            <label className="memory-note advanced-toggle">
              <input
                type="checkbox"
                checked={Boolean(settings?.advancedMode)}
                onChange={(event) => void setAdvancedMode(event.target.checked)}
              />
              Show thinking and tool calls
            </label>
            <p className="sheet-help">
              Every turn shows each message the model wrote, with the thinking
              and tool calls between the messages folded into blocks you can
              open again, and the sidebar lists the coding agents with a
              read-only view of what each one did. With it off, only the last
              message of each turn is shown. Off by default, because it is a
              lot of detail.
            </p>

            <div className="sheet-subhead">
              <span>
                <CloudOff strokeWidth={1.8} />
                Cloud sync
              </span>
            </div>
            <SyncControl />
          </section>

          {auth?.signedIn && (
            <section className="sheet-section">
              <div className="sheet-label">
                <span>Your machines</span>
                <span className="status" data-on={devices?.state === "online"}>
                  {devices?.state === "online" ? "Connected" : "…"}
                </span>
              </div>
              <p className="sheet-help">
                Run coding agents on a computer without being at it. Hook on
                another computer appears here while it is running; a phone or
                Hook Workspace can start work on any of them.
              </p>
              <MachinesSection
                machines={devices?.devices ?? []}
                selfId={devices?.selfId ?? ""}
                state={devices?.state ?? "connecting"}
                message={devices?.message}
                onRename={(id, name) => renameDevice(id, name)}
                onSetRemote={(id, allowed) => setDeviceRemote(id, allowed)}
                onRemove={(id) => removeDevice(id)}
              />
            </section>
          )}

          <MemorySection />

          <section className="sheet-section">
            <div className="sheet-label">
              <span>Projects folder</span>
            </div>
            <p className="sheet-help">
              Every project lives in one folder. Chats can create projects here and
              hand work to coding agents inside them.
            </p>
            <div className="path-row">
              <code className="path-box">{settings?.projectsDir ?? "…"}</code>
              <button className="btn" onClick={() => void chooseProjectsDir()}>
                Choose…
              </button>
              <button
                className="btn btn-ghost"
                title="Open in Explorer"
                onClick={() =>
                  settings && void api.openPath(settings.projectsDir)
                }
              >
                <FolderOpen strokeWidth={1.9} />
              </button>
            </div>

            {settings?.projects.length ? (
              <ul className="project-list">
                {settings.projects.map((project) => (
                  <li key={project.path}>
                    <div className="project-name">
                      {project.name}
                      {project.isGit && (
                        <span className="badge">
                          <GitBranch strokeWidth={2} />
                          git
                        </span>
                      )}
                    </div>
                    <div className="project-desc">
                      {project.description || (
                        <span className="muted">No description yet</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sheet-help muted">
                No projects yet. Ask for something and the chat agent will create one.
              </p>
            )}
          </section>

          <section className="sheet-section">
            <div className="sheet-label">
              <span>Updates</span>
            </div>
            <div className="update-settings-row">
              <div className="update-settings-copy">
                <strong>Hook {update?.current ?? version ?? "…"}</strong>
                <span>
                  {update
                    ? update.available
                      ? `Version ${update.latest} is available.`
                      : "You’re on the latest version."
                    : "Check whether a newer version is available."}
                </span>
              </div>
              {update?.available ? (
                <button
                  className="btn btn-primary"
                  onClick={() => void installUpdate()}
                  disabled={installing || closing}
                >
                  <ArrowUpCircle strokeWidth={1.9} />
                  {closing
                    ? "Closing Hook…"
                    : installing
                      ? "Updating…"
                      : update?.channel === "store"
                        ? "Close Hook and update"
                        : "Update now"}
                </button>
              ) : (
                <button
                  className="btn"
                  onClick={() => void checkUpdate()}
                  disabled={checking}
                >
                  <RefreshCw strokeWidth={1.9} className={checking ? "spin" : undefined} />
                  {checking ? "Checking…" : "Check for updates"}
                </button>
              )}
            </div>
            <p className="sheet-help">
              {update?.channel === "store"
                ? "Updates come from the Microsoft Store. Hook closes so the Store can replace it — reopen it when the Store finishes. Your chats and projects stay where they are."
                : "Updates install from inside Hook and restart it. Your chats and projects stay where they are."}
              {update && update.minimum !== "0.0.0" ? (
                <> Hook {update.minimum} is the oldest supported version.</>
              ) : null}
            </p>
          </section>

          <AboutSection version={update?.current ?? version} />

          <p className="sheet-foot">
            Hook talks to its own account service. A model provider you enter is
            used from this computer only.
          </p>
        </div>
      </div>
    </div>
  );
}
