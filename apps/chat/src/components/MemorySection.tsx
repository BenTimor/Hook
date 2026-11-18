import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Pin, Trash2 } from "lucide-react";

import { api, onSyncEvent } from "../lib/bridge";
import type { MemoryEntry, MemoryView } from "../lib/types";
import { useChatStore } from "../store/useChatStore";

/**
 * What the chat remembers between conversations.
 *
 * Two shapes on one screen, because they are the same list seen two ways: a
 * pinned memory is in every prompt, an unpinned one is found with
 * `memory_search` when it matters. Everything here is editable and deletable —
 * a memory the user cannot see is a memory they cannot trust.
 */
export function MemorySection() {
  const [view, setView] = useState<MemoryView | null>(null);
  const [draft, setDraft] = useState("");
  const [draftPinned, setDraftPinned] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const select = useChatStore((s) => s.select);
  const closeSettings = useChatStore((s) => s.closeSettings);

  const load = useCallback(() => {
    void api
      .memoryList()
      .then(setView)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // Another computer added something: show it without reopening the sheet.
    return onSyncEvent((event) => {
      if (event.memory) load();
    });
  }, [load]);

  const run = useCallback(
    (action: Promise<MemoryView>) => {
      setBusy(true);
      setError(null);
      action
        .then((next) => {
          setView(next);
          setConfirmClear(false);
        })
        .catch((failure: unknown) => {
          setError(typeof failure === "string" ? failure : "That did not work.");
        })
        .finally(() => setBusy(false));
    },
    [],
  );

  const add = () => {
    if (!draft.trim()) return;
    run(api.memorySave(draft, draftPinned));
    setDraft("");
  };

  const startEdit = (entry: MemoryEntry) => {
    setEditing(entry.id);
    setEditText(entry.text);
  };

  const commitEdit = (entry: MemoryEntry) => {
    const text = editText.trim();
    setEditing(null);
    if (!text || text === entry.text) return;
    run(api.memoryUpdate(entry.id, text, null));
  };

  if (!view) return null;
  const pinnedLabel =
    view.pinned >= view.maxPinned
      ? `${view.pinned} of ${view.maxPinned} pinned — full`
      : `${view.pinned} of ${view.maxPinned} pinned`;

  return (
    <section className="sheet-section">
      <div className="sheet-label">
        <span>Memory</span>
        {view.available && (
          <span className={`status ${view.pinned >= view.maxPinned ? "bad" : "ok"}`}>
            {pinnedLabel}
          </span>
        )}
      </div>
      <p className="sheet-help">
        What the chat keeps between conversations. Pinned memories are in every
        chat; the rest are looked up when they matter. Only what you say is
        remembered — never a web page or a coding agent's report.
      </p>

      {!view.available ? (
        <p className="sheet-help muted">This build has memory turned off.</p>
      ) : (
        <>
          <div className="memory-compose">
            <input
              className="memory-input"
              value={draft}
              placeholder="Something to remember…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
            <button
              className="btn btn-primary"
              onClick={add}
              disabled={busy || !draft.trim()}
            >
              Add
            </button>
          </div>
          <label className="memory-note">
            <input
              type="checkbox"
              checked={draftPinned}
              onChange={(event) => setDraftPinned(event.target.checked)}
            />
            Always know this, in every chat
          </label>

          {error && <p className="sheet-help bad">{error}</p>}

          {view.entries.length === 0 ? (
            <p className="sheet-help muted">
              Nothing remembered yet. Ask for something and it will start
              remembering what matters.
            </p>
          ) : (
            <ul className="memory-list">
              {view.entries.map((entry) => (
                <li key={entry.id} className={entry.pinned ? "is-pinned" : undefined}>
                  <button
                    className={`memory-pin ${entry.pinned ? "on" : ""}`}
                    title={
                      entry.pinned
                        ? "Pinned: in every chat. Click to stop."
                        : "Pin: always in the prompt. Click to add."
                    }
                    onClick={() =>
                      run(api.memoryUpdate(entry.id, null, !entry.pinned))
                    }
                    disabled={busy}
                  >
                    <Pin strokeWidth={2} />
                  </button>
                  {editing === entry.id ? (
                    <input
                      className="memory-input"
                      autoFocus
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                      onBlur={() => commitEdit(entry)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitEdit(entry);
                        if (event.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <button
                      className="memory-text"
                      onClick={() => startEdit(entry)}
                      title="Click to edit"
                    >
                      <span>{entry.text}</span>
                      <span className="memory-meta">
                        {entry.age}
                        {entry.pinned ? " · always" : ""}
                        {` · ${entry.kind}`}
                      </span>
                    </button>
                  )}
                  {entry.chatId && (
                    <button
                      className="memory-forget"
                      title="Open the chat this came from"
                      onClick={() => {
                        closeSettings();
                        void select(entry.chatId);
                      }}
                    >
                      <MessageSquare strokeWidth={1.9} />
                    </button>
                  )}
                  <button
                    className="memory-forget"
                    title="Forget this"
                    onClick={() => run(api.memoryDelete(entry.id))}
                    disabled={busy}
                  >
                    <Trash2 strokeWidth={1.9} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="memory-foot">
            <label className="memory-note">
              <input
                type="checkbox"
                checked={view.enabled}
                onChange={(event) =>
                  run(api.memorySetEnabled(event.target.checked))
                }
                disabled={busy}
              />
              Use memory in chats
            </label>
            {view.entries.length > 0 && (
              <button
                className="inline-link"
                onClick={() => {
                  if (!confirmClear) {
                    setConfirmClear(true);
                    return;
                  }
                  run(api.memoryClear());
                }}
                disabled={busy}
              >
                {confirmClear ? "Click again to forget everything" : "Forget everything"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
