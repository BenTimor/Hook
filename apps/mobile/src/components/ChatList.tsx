import { useState } from "react";
import {
  ChevronLeft,
  CloudOff,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { TextFieldDialog } from "@hook/ui";

import type { ChatMeta } from "../lib/types";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import { useMobileChat } from "../store/useMobileChat";
import { when } from "./when";

/**
 * The archive. It is no longer the root screen: a conversation opens on the
 * new-chat page, and this list is one tap away behind the history button. It
 * is still where a chat is renamed, pinned or deleted; those actions live
 * behind the button on each row, because a long-press has nowhere to show a
 * menu from.
 */
export function ChatList({
  onBack,
  onSettings,
}: {
  onBack: () => void;
  onSettings: () => void;
}) {
  const chats = useMobileChat((s) => s.chats);
  const devices = useMobileChat((s) => s.devices?.devices);
  const sync = useMobileChat((s) => s.sync);
  const open = useMobileChat((s) => s.open);
  const newChat = useMobileChat((s) => s.newChat);
  const renameChat = useMobileChat((s) => s.renameChat);
  const togglePinned = useMobileChat((s) => s.togglePinned);
  const removeChat = useMobileChat((s) => s.removeChat);

  // A chat that is not in the cloud is every chat while sync is off; the mark
  // opens Settings, where the reason (free plan, or the account's switch) is.
  const unsynced = Boolean(sync && !sync.enabled);

  const [actionsFor, setActionsFor] = useState<ChatMeta | null>(null);
  const [renaming, setRenaming] = useState<ChatMeta | null>(null);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const closeActions = () => {
    setActionsFor(null);
    setConfirmingDelete(false);
  };

  // Back closes the row menu or the rename dialog first, then the list.
  useBackHandler(BACK_LAYER.screen, true, () => {
    if (renaming) {
      setRenaming(null);
      return;
    }
    if (actionsFor) {
      closeActions();
      return;
    }
    onBack();
  });

  return (
    <section className="screen" aria-label="Conversations">
      <header className="bar">
        <button className="icon-btn" title="Back" onClick={onBack}>
          <ChevronLeft strokeWidth={2} />
        </button>
        <div className="bar-title">Chats</div>
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
              <button
                className="row"
                onClick={() => {
                  void open(chat.id);
                  onBack();
                }}
              >
                <div className="row-main">
                  <span className="row-title">
                    {chat.pinned ? (
                      <Pin className="row-pin" strokeWidth={2} aria-label="Pinned" />
                    ) : null}
                    {chat.title}
                  </span>
                  <span className="row-preview">
                    {chat.remote
                      ? `On ${
                          devices?.find((device) => device.id === chat.deviceId)?.name ??
                          chat.deviceName ??
                          "another machine"
                        }`
                      : chat.preview || "No reply yet"}
                  </span>
                </div>
                <span className="row-when">{when(chat.updatedAt)}</span>
              </button>
              {unsynced && (
                <button
                  className="row-sync"
                  title={
                    sync?.reason === "free"
                      ? "Not in the cloud — the free plan keeps chats on this phone."
                      : "Not in the cloud — cloud sync is off."
                  }
                  aria-label="This chat is not synced to the cloud"
                  onClick={onSettings}
                >
                  <CloudOff strokeWidth={2} />
                </button>
              )}
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
        <button
          className="fab"
          onClick={() => {
            newChat();
            onBack();
          }}
        >
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
              {actionsFor.remote ? (
                <button className="action" disabled>
                  <SquareTerminal strokeWidth={1.8} />
                  Lives on {actionsFor.deviceName ?? "another machine"}
                </button>
              ) : (
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
              )}
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
