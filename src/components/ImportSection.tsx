import { useEffect, useState } from "react";
import { AlertTriangle, Check, FileArchive, X } from "lucide-react";
import { toast } from "sonner";

import { api, onImportEvent, openExternal } from "../lib/bridge";
import type { ImportPreview, ImportSummary } from "../lib/types";
import { useChatStore } from "../store/useChatStore";

type VendorKey = "chatgpt" | "claude";

const VENDORS: {
  key: VendorKey;
  name: string;
  steps: string;
  help: string;
  helpLabel: string;
}[] = [
  {
    key: "chatgpt",
    name: "ChatGPT",
    steps: "Settings → Data controls → Export data. ChatGPT emails you a ZIP.",
    help: "https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data",
    helpLabel: "How to export",
  },
  {
    key: "claude",
    name: "Claude",
    steps: "Settings → Privacy → Export data. Claude emails you a download link.",
    help: "https://support.claude.com/en/articles/9450526-how-can-i-export-my-claude-data",
    helpLabel: "How to export",
  },
];

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

/** The counts line under the confirmation: what this file would change. */
function Counts({ preview }: { preview: ImportPreview }) {
  const parts: { value: number; label: string }[] = [
    { value: preview.new, label: preview.new === 1 ? "new chat" : "new chats" },
    { value: preview.updated, label: "updated" },
    { value: preview.unchanged, label: "already here" },
    { value: preview.keptLocal, label: "kept as yours" },
  ].filter((part) => part.value > 0);
  return (
    <div className="import-counts">
      {parts.map((part) => (
        <span key={part.label}>
          <b>{part.value.toLocaleString()}</b> {part.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Bringing history over from another assistant.
 *
 * The file is the one the vendor's own export produces: nothing here signs in
 * to ChatGPT or Claude, and nothing is uploaded anywhere but the user's own
 * account. An import that has already happened is updated in place on the next
 * run, which is why the same button doubles as "re-import".
 */
export function ImportSection() {
  const refreshChats = useChatStore((s) => s.refreshChats);
  const select = useChatStore((s) => s.select);
  const closeSettings = useChatStore((s) => s.closeSettings);

  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<{
    kind: "scan" | "apply";
    vendor?: VendorKey;
  } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onImportEvent((event) => {
        if (event.phase === "importing") {
          setProgress({ done: event.done, total: event.total });
        }
      }),
    [],
  );

  const reset = () => {
    setPath(null);
    setPreview(null);
    setSummary(null);
    setProgress(null);
    setError(null);
  };

  const pick = async (vendor: VendorKey) => {
    reset();
    let picked: string | null = null;
    try {
      picked = await api.pickImportFile(vendor);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    if (!picked) return;
    setBusy({ kind: "scan", vendor });
    try {
      const found = await api.importScan(picked);
      setPath(picked);
      setPreview(found);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!path || !preview) return;
    setBusy({ kind: "apply" });
    setError(null);
    setProgress({ done: 0, total: preview.conversations });
    try {
      const result = await api.importApply(path);
      setSummary(result);
      setPreview(null);
      setPath(null);
      await refreshChats();
      toast.success(
        result.imported + result.updated === 1
          ? "Imported 1 conversation"
          : `Imported ${(result.imported + result.updated).toLocaleString()} conversations`,
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const openFirst = () => {
    const id = summary?.chatIds[0];
    if (!id) return;
    closeSettings();
    void select(id);
  };

  return (
    <section className="sheet-section">
      <div className="sheet-label">
        <span>Import history</span>
      </div>
      <p className="sheet-help">
        Bring your conversations over from another assistant. Download your
        export there, then choose the file here — it is read on this computer and
        joins your history like any other chat.
      </p>

      <div className="import-list">
        {VENDORS.map((vendor) => (
          <div className="import-card" key={vendor.key}>
            <div className="import-card-head">
              <FileArchive className="import-mark" strokeWidth={1.8} />
              <strong>From {vendor.name}</strong>
              <div className="import-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => void openExternal(vendor.help)}
                >
                  {vendor.helpLabel}
                </button>
                <button
                  className="btn"
                  onClick={() => void pick(vendor.key)}
                  disabled={busy !== null}
                >
                  {busy?.kind === "scan" && busy.vendor === vendor.key
                    ? "Reading…"
                    : "Choose file…"}
                </button>
              </div>
            </div>
            <p className="import-help">{vendor.steps}</p>
          </div>
        ))}
      </div>

      {preview && (
        <div className="import-confirm">
          <div className="import-confirm-head">
            <strong>
              {preview.vendor} export ·{" "}
              {preview.conversations.toLocaleString()}{" "}
              {plural(preview.conversations, "conversation")}
            </strong>
            <span className="muted">{preview.file}</span>
          </div>
          <Counts preview={preview} />
          <p className="import-note">
            Conversations you have already imported are updated in place. Anything
            you have written in Hook since stays as you left it.
          </p>
          {progress && (
            <div className="update-progress">
              <div className="update-progress-track">
                <span
                  style={{
                    width: `${
                      progress.total
                        ? Math.round((progress.done / progress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <span className="update-progress-label">
                Importing {progress.done.toLocaleString()} of{" "}
                {progress.total.toLocaleString()}
              </span>
            </div>
          )}
          {preview.warnings.map((warning) => (
            <p className="import-warning" key={warning}>
              <AlertTriangle strokeWidth={2} />
              {warning}
            </p>
          ))}
          <div className="import-row">
            <button className="btn btn-ghost" onClick={reset} disabled={busy !== null}>
              <X strokeWidth={2} />
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void run()}
              disabled={busy !== null || preview.new + preview.updated === 0}
            >
              {busy?.kind === "apply"
                ? "Importing…"
                : preview.new + preview.updated === 0
                  ? "Nothing new to import"
                  : `Import ${(
                      preview.new + preview.updated
                    ).toLocaleString()} ${plural(
                      preview.new + preview.updated,
                      "conversation",
                    )}`}
            </button>
          </div>
        </div>
      )}

      {summary && (
        <div className="import-done">
          <Check strokeWidth={2.2} />
          <span>
            {summary.imported.toLocaleString()} imported
            {summary.updated > 0 && `, ${summary.updated.toLocaleString()} updated`}
            {summary.keptLocal > 0 &&
              `. ${summary.keptLocal.toLocaleString()} left as you had ${
                summary.keptLocal === 1 ? "it" : "them"
              } because you have written there since`}
            {summary.unchanged > 0 &&
              `. ${summary.unchanged.toLocaleString()} ${
                summary.unchanged === 1 ? "was" : "were"
              } already here`}
            . They sync to your account like everything else.
          </span>
          {summary.chatIds.length > 0 && (
            <button className="inline-link" onClick={openFirst}>
              Open the newest
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="update-error">
          {error}
        </p>
      )}
    </section>
  );
}
