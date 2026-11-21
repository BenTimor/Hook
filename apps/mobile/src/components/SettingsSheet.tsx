import { useEffect, useState } from "react";
import { LogOut, X } from "lucide-react";

import { mobile } from "../lib/api";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import type { SyncView } from "../lib/types";
import { useMobileChat } from "../store/useMobileChat";

/**
 * Settings, as a sheet.
 *
 * A phone has one account, one switch that changes how a reply is drawn
 * (advanced mode), a sync line and a way out. Everything else the desktop's
 * sheet holds — projects folder, updates, import — belongs to a machine that
 * owns files, and this one does not.
 */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const auth = useMobileChat((s) => s.auth);
  const settings = useMobileChat((s) => s.settings);
  const setAdvanced = useMobileChat((s) => s.setAdvanced);
  const signOut = useMobileChat((s) => s.signOut);
  const [sync, setSync] = useState<SyncView | null>(null);
  const [version, setVersion] = useState("");

  useBackHandler(BACK_LAYER.sheet, true, onClose);

  useEffect(() => {
    void mobile.appInfo().then((info) => setVersion(info.version)).catch(() => undefined);
    void mobile
      .syncStatus()
      .then(setSync)
      .catch(() => undefined);
  }, []);

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
              <strong>Sync</strong>
              <em>
                {sync
                  ? `${sync.state === "syncing" ? "Syncing…" : "Up to date"} · ${sync.cursor} changes`
                  : "Checking…"}
              </em>
            </span>
            <button className="btn" onClick={() => void mobile.syncNow()}>
              Now
            </button>
          </div>

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
