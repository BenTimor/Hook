import { useState } from "react";
import { MoreHorizontal, Pin, PinOff, Plus, Settings, Trash2, Pencil } from "lucide-react";

import { HookMark, TextFieldDialog } from "@hook/ui";

import type { ChatMeta } from "../lib/types";
import { useMobileChat } from "../store/useMobileChat";
import { when } from "./when";

/**
 * The list. A phone opens on the last conversation, not on a sidebar, so this
 * is the root screen: newest first, one line of preview, the ordering the
 * backend returns (pinned first, then by `updatedAt`).
 *
 * The actions that a desktop puts in a right-click menu live behind the button
 * on each row, because a long-press has nowhere to show a menu from.
 */
export function ChatList({ onSettings }: { onSettings: () => void }) {
  const chats = useMobileChat((s) => s.chats);
  const open = useMobileChat((s) => s.open);
  const newChat = useMobileChat((s) => s.newChat);
  const renameChat = useMobileChat((s) => s.renameChat);
  const togglePinned = useMobileChat((s) => s.togglePinned);
  const removeChat = useMobileChat((s) => s.removeChat);

  const [actionsFor, setActionsFor] = useState<ChatMeta | null>(null);
  const [renaming, setRenaming] = useState<ChatMeta | null>(null);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const closeActions = () => {
    setActionsFor(null);
    setConfirmingDelete(false);
  };

  return (
    <section className="screen" aria-label="Conversations">
      <header className="bar bar-root">
        <div className="bar-brand">
          <HookMark />
          <span>Hook</span>
        </div>
        <button className="icon-btn" title="Settings" onClick={onSettings}>
          <Settings strokeWidth={1.8} />
        </button>
      </header>

      <div className="list">
        {chats.length === 0 ? (
          <div className="empty">
            <div className="empty-title">Nothing here yet</div>
            <p>Ask Hook what is on your board, or start something new.</p>
          </div>
        ) : (
          chats.map((chat) => (
            <div className="row-wrap" key={chat.id}>
              <button className="row" onClick={() => void open(chat.id)}>
                <div className="row-main">
                  <span className="row-title">
                    {chat.pinned ? (
                      <Pin className="row-pin" strokeWidth={2} aria-label="Pinned" />
                    ) : null}
                    {chat.title}
                  </span>
                  <span className="row-preview">
                    {chat.preview || "No reply yet"}
                  </span>
                </div>
                <span className="row-when">{when(chat.updatedAt)}</span>
              </button>
              <button
                className="row-more"
                title="Chat actions"
                aria-label={`Actions for ${chat.title}`}
                onClick={() => setActionsFor(chat)}
              >
                <MoreHorizontal strokeWidth={2} />
              </button>
            </div>
          ))
        )}
      </div>

      <div className="fab-row">
        <button className="fab" onClick={newChat}>
          <Plus strokeWidth={2} />
          New chat
        </button>
      </div>

      {actionsFor ? (
        <div className="sheet-backdrop" onMouseDown={closeActions}>
          <div
            className="sheet sheet-actions"
            role="dialog"
            aria-modal="true"
            aria-label="Chat actions"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheet-grip" aria-hidden="true" />
            <div className="sheet-head">
              <div className="sheet-heading">
                <div className="sheet-title">{actionsFor.title}</div>
                <div className="sheet-note">{when(actionsFor.updatedAt)}</div>
              </div>
            </div>
            <div className="sheet-body actions">
              <button
                className="action"
                onClick={() => {
                  void togglePinned(actionsFor.id, !actionsFor.pinned);
                  closeActions();
                }}
              >
                {actionsFor.pinned ? (
                  <PinOff strokeWidth={1.8} />
                ) : (
                  <Pin strokeWidth={1.8} />
                )}
                {actionsFor.pinned ? "Unpin from the top" : "Pin to the top"}
              </button>
              <button
                className="action"
                onClick={() => {
                  setName(actionsFor.title);
                  setRenaming(actionsFor);
                  closeActions();
                }}
              >
                <Pencil strokeWidth={1.8} />
                Rename
              </button>
              <button
                className="action action-danger"
                onClick={() => {
                  if (!confirmingDelete) {
                    // A phone deletes with a thumb, so the second tap is the
                    // confirmation. The desktop has an undo in its toast; there
                    // is nowhere to put one here.
                    setConfirmingDelete(true);
                    return;
                  }
                  void removeChat(actionsFor.id);
                  closeActions();
                }}
              >
                <Trash2 strokeWidth={1.8} />
                {confirmingDelete ? "Delete permanently" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <TextFieldDialog
        open={Boolean(renaming)}
        title="Rename chat"
        label="Title"
        value={name}
        onChange={setName}
        confirm="Save"
        onClose={() => setRenaming(null)}
        onConfirm={() => {
          if (renaming) void renameChat(renaming.id, name);
          setRenaming(null);
        }}
      />
    </section>
  );
}
