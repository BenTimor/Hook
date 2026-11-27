import { useMemo, useState, type CSSProperties, type HTMLAttributes } from "react";
import {
  ChevronRight,
  CloudOff,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";

import { HookMark, TextFieldDialog } from "@hook/ui";

import type { ChatMeta } from "../lib/types";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import { useMobileChat } from "../store/useMobileChat";
import { when } from "./when";

type DrawerView = "chats" | "workspace";

type Group = { label: string; chats: ChatMeta[] };

const DAY = 86_400_000;

/** The four buckets the drawer shows, newest first. */
function historyGroups(chats: ChatMeta[]): Group[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const groups: Group[] = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "Previous 7 Days", chats: [] },
    { label: "Older", chats: [] },
  ];
  for (const chat of chats) {
    if (chat.updatedAt >= today) groups[0].chats.push(chat);
    else if (chat.updatedAt >= today - DAY) groups[1].chats.push(chat);
    else if (chat.updatedAt >= today - 7 * DAY) groups[2].chats.push(chat);
    else groups[3].chats.push(chat);
  }
  for (const group of groups) group.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups.filter((group) => group.chats.length > 0);
}

function planName(plan: string | null | undefined): string {
  if (plan === "free") return "Free";
  if (plan === "plus") return "Hook Plus";
  if (plan === "pro") return "Hook Pro";
  return "Preview";
}

/**
 * Chat history as a drawer, not a destination.
 *
 * The list is the same account data the desktop sidebar reads; the drawer only
 * changes where it is drawn. A conversation is opened through the store, and
 * the row menu keeps the pin/rename/delete actions the old archive had.
 */
export function ChatDrawer({
  open,
  dragging,
  view,
  style,
  backdropStyle,
  panelProps,
  onClose,
  onNewChat,
  onSelectChat,
  onChats,
  onWorkspace,
  onSettings,
}: {
  open: boolean;
  dragging: boolean;
  view: DrawerView;
  style?: CSSProperties;
  backdropStyle?: CSSProperties;
  panelProps?: HTMLAttributes<HTMLDivElement>;
  onClose: () => void;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  onChats: () => void;
  onWorkspace: () => void;
  onSettings: () => void;
}) {
  const chats = useMobileChat((s) => s.chats);
  const devices = useMobileChat((s) => s.devices?.devices);
  const sync = useMobileChat((s) => s.sync);
  const advanced = useMobileChat((s) => Boolean(s.settings?.advancedMode));
  const activeId = useMobileChat((s) => s.activeId);
  const auth = useMobileChat((s) => s.auth);
  const settings = useMobileChat((s) => s.settings);
  const renameChat = useMobileChat((s) => s.renameChat);
  const togglePinned = useMobileChat((s) => s.togglePinned);
  const removeChat = useMobileChat((s) => s.removeChat);

  const [query, setQuery] = useState("");
  const [actionsFor, setActionsFor] = useState<ChatMeta | null>(null);
  const [renaming, setRenaming] = useState<ChatMeta | null>(null);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useBackHandler(BACK_LAYER.sheet, open && Boolean(actionsFor), () => {
    setActionsFor(null);
    setConfirmingDelete(false);
  });
  useBackHandler(BACK_LAYER.dialog, renaming !== null, () => setRenaming(null));

  const listed = useMemo(() => {
    const visible = advanced ? chats : chats.filter((chat) => chat.kind !== "coding");
    const needle = query.trim().toLowerCase();
    if (!needle) return visible;
    return visible.filter((chat) =>
      `${chat.title} ${chat.preview ?? ""}`.toLowerCase().includes(needle),
    );
  }, [advanced, chats, query]);

  const pinned = useMemo(
    () => listed.filter((chat) => chat.pinned).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    [listed],
  );
  const groups = useMemo(
    () => historyGroups(listed.filter((chat) => !chat.pinned)),
    [listed],
  );

  const closeActions = () => {
    setActionsFor(null);
    setConfirmingDelete(false);
  };

  // A chat that is not in the cloud is every chat while sync is off; the mark
  // opens Settings, where the reason (a free plan, or the account's switch) is.
  const unsynced = Boolean(sync && !sync.enabled);
  const accountName = auth?.name ?? auth?.email ?? "Hook account";
  const initial = accountName.trim().slice(0, 1).toUpperCase();
  const plan = planName(settings?.plan ?? auth?.plan);

  const row = (chat: ChatMeta) => (
    <div
      className="drawer-chat"
      data-active={chat.id === activeId || undefined}
      key={chat.id}
    >
      <button
        className="drawer-chat-main"
        onClick={() => onSelectChat(chat.id)}
      >
        <span className="drawer-chat-title">
          {chat.pinned ? <Pin className="drawer-chat-pin" strokeWidth={2} /> : null}
          {chat.title}
        </span>
        <span className="drawer-chat-preview">
          {chat.remote
            ? `On ${
                devices?.find((device) => device.id === chat.deviceId)?.name ??
                chat.deviceName ??
                "another machine"
              }`
            : chat.preview || "New conversation"}
        </span>
      </button>
      {unsynced ? (
        <button
          className="drawer-chat-unsynced"
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
      ) : null}
      <span className="drawer-chat-time">{when(chat.updatedAt)}</span>
      <button
        className="drawer-chat-more"
        title="Chat actions"
        aria-label={`Actions for ${chat.title}`}
        onClick={() => setActionsFor(chat)}
      >
        <MoreHorizontal strokeWidth={2} />
      </button>
    </div>
  );

  return (
    <>
      <div
        className="chat-drawer-backdrop"
        data-open={open || dragging || undefined}
        style={backdropStyle}
        onMouseDown={onClose}
      />
      <aside
        className="chat-drawer"
        data-open={open || dragging || undefined}
        data-dragging={dragging || undefined}
        style={style}
        aria-hidden={!open && !dragging}
        aria-label="Chats and workspace"
        {...panelProps}
      >
        <header className="drawer-top">
          <div className="drawer-brand">
            <HookMark />
            <span>Hook</span>
          </div>
          <button
            className="icon-btn"
            title="Close"
            aria-label="Close chats"
            onClick={onClose}
          >
            <X strokeWidth={2} />
          </button>
        </header>

        <button className="drawer-new" onClick={onNewChat}>
          <Plus strokeWidth={2} />
          New chat
        </button>

        <label className="drawer-search">
          <Search strokeWidth={1.9} />
          <input
            type="search"
            value={query}
            placeholder="Search chats"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <nav className="drawer-nav" aria-label="Hook">
          <button
            className="drawer-nav-row"
            data-active={view === "chats" || undefined}
            onClick={onChats}
          >
            <MessageSquare strokeWidth={1.8} />
            Chats
            {view === "chats" ? <ChevronRight className="drawer-nav-chevron" strokeWidth={2} /> : null}
          </button>
          <button
            className="drawer-nav-row"
            data-active={view === "workspace" || undefined}
            onClick={onWorkspace}
          >
            <HookMark className="drawer-nav-mark" />
            Workspace
            {view === "workspace" ? <ChevronRight className="drawer-nav-chevron" strokeWidth={2} /> : null}
          </button>
        </nav>

        <div className="drawer-history">
          {listed.length === 0 ? (
            <p className="drawer-empty">
              {query.trim() ? "No chats match that search." : "Your conversations will appear here."}
            </p>
          ) : (
            <>
              {pinned.length > 0 ? (
                <section className="drawer-group">
                  <div className="drawer-group-label">Pinned</div>
                  {pinned.map(row)}
                </section>
              ) : null}
              {groups.map((group) => (
                <section className="drawer-group" key={group.label}>
                  <div className="drawer-group-label">{group.label}</div>
                  {group.chats.map(row)}
                </section>
              ))}
            </>
          )}
        </div>

        <button className="drawer-account" onClick={onSettings}>
          <span className="drawer-avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="drawer-account-copy">
            <strong>{accountName}</strong>
            <em>{plan} · Manage account</em>
          </span>
          <Settings strokeWidth={1.8} />
        </button>
      </aside>

      {actionsFor ? (
        <div
          className="sheet-backdrop"
          onMouseDown={closeActions}
        >
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
              ) : null}
              <button
                className="action action-danger"
                disabled={
                  actionsFor.remote &&
                  devices?.find((device) => device.id === actionsFor.deviceId)
                    ?.hostOnline === false
                }
                onClick={() => {
                  if (!confirmingDelete) {
                    // A phone deletes with a thumb, so the second tap is the
                    // confirmation: there is nowhere for an undo toast.
                    setConfirmingDelete(true);
                    return;
                  }
                  void removeChat(actionsFor.id);
                  closeActions();
                }}
              >
                <Trash2 strokeWidth={1.8} />
                {confirmingDelete
                  ? actionsFor.remote
                    ? `Delete on ${
                        devices?.find((device) => device.id === actionsFor.deviceId)
                          ?.name ??
                        actionsFor.deviceName ??
                        "that machine"
                      }`
                    : "Delete permanently"
                  : "Delete"}
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
    </>
  );
}
