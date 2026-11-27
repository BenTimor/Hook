import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
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

import { mobile } from "../lib/api";
import type { ChatMeta } from "../lib/types";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import { useMobileChat } from "../store/useMobileChat";
import { when } from "./when";

type Group = { label: string; chats: ChatMeta[] };

const DAY = 86_400_000;

/** How long a finger has to rest on a row before its actions are armed. */
const LONG_PRESS = 450;

/** The menu's exit, matched to `menu-out` in `mobile.css`. */
const MENU_EXIT = 160;

const MENU_WIDTH = 236;
const MENU_MARGIN = 12;
/** The status bar/header, and the home indicator: the menu stays inside both. */
const MENU_SAFE_TOP = 56;
const MENU_SAFE_BOTTOM = 24;
const MENU_GAP = 10;

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

type Press = {
  timer: number;
  x: number;
  y: number;
  chat: ChatMeta;
  /** Where the row was when the press began: the menu emerges from there. */
  rect: DOMRect;
  fired: boolean;
  moved: boolean;
};

type MenuState = {
  chat: ChatMeta;
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  /** The small entry/exit offset, toward or away from the row. */
  shift: number;
  origin: string;
};

/**
 * Chat history as a drawer, not a destination.
 *
 * The list is the account data the desktop sidebar reads; the drawer only
 * changes where it is drawn. A row is a title and a stamp — the conversation
 * itself is one tap away, so a preview would spend a line saying what the chat
 * already says. The actions are a long press: the same sheet the old row menu
 * opened, reached the way a phone reaches one.
 */
export function ChatDrawer({
  open,
  dragging,
  style,
  backdropStyle,
  panelProps,
  backdropProps,
  onClose,
  onNewChat,
  onSelectChat,
  onSettings,
}: {
  open: boolean;
  dragging: boolean;
  style?: CSSProperties;
  backdropStyle?: CSSProperties;
  panelProps?: HTMLAttributes<HTMLDivElement>;
  backdropProps?: HTMLAttributes<HTMLDivElement>;
  onClose: () => void;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  onSettings: () => void;
}) {
  const chats = useMobileChat((s) => s.chats);
  const devices = useMobileChat((s) => s.devices?.devices);
  const advanced = useMobileChat((s) => Boolean(s.settings?.advancedMode));
  const activeId = useMobileChat((s) => s.activeId);
  const auth = useMobileChat((s) => s.auth);
  const settings = useMobileChat((s) => s.settings);
  const renameChat = useMobileChat((s) => s.renameChat);
  const togglePinned = useMobileChat((s) => s.togglePinned);
  const removeChat = useMobileChat((s) => s.removeChat);

  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<ChatMeta | null>(null);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  /** The row held down now (or owning the open sheet), drawn a shade darker. */
  const [pressedId, setPressedId] = useState<string | null>(null);

  const press = useRef<Press | null>(null);
  const menuTimer = useRef<number | null>(null);
  const actionsTimer = useRef<number | null>(null);
  // The row whose click belongs to the long press, not to opening a chat.
  const suppressClick = useRef<string | null>(null);

  useBackHandler(BACK_LAYER.sheet, open && Boolean(menu), () => {
    closeMenu();
  });
  useBackHandler(BACK_LAYER.dialog, renaming !== null, () => setRenaming(null));

  const clearPress = () => {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  };

  useEffect(
    () => () => {
      clearPress();
      if (menuTimer.current) window.clearTimeout(menuTimer.current);
      if (actionsTimer.current) window.clearTimeout(actionsTimer.current);
    },
    [],
  );

  const listed = useMemo(() => {
    // A conversation with a directly-driven agent is this switch's feature, the
    // same rule the desktop sidebar applies.
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

  /** Animate the popover out, then drop it; every close path comes through here. */
  const closeMenu = () => {
    if (!menu || menuClosing) return;
    suppressClick.current = null;
    setMenuClosing(true);
    if (actionsTimer.current) window.clearTimeout(actionsTimer.current);
    actionsTimer.current = window.setTimeout(() => {
      actionsTimer.current = null;
      setMenu(null);
      setMenuClosing(false);
      setConfirmingDelete(false);
      setPressedId(null);
    }, MENU_EXIT);
  };

  const showActions = (chat: ChatMeta, rect: DOMRect) => {
    if (actionsTimer.current) {
      window.clearTimeout(actionsTimer.current);
      actionsTimer.current = null;
    }
    // A context menu, not a sheet: it sits beside the row, above it near the
    // bottom and below it near the top, clamped to the window.
    const width = Math.min(MENU_WIDTH, window.innerWidth - MENU_MARGIN * 2);
    const estimated = chat.remote ? 230 : 196;
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - MENU_SAFE_BOTTOM;
    const spaceAbove = rect.top - MENU_GAP - MENU_SAFE_TOP;
    const below = spaceBelow >= estimated || spaceBelow >= spaceAbove;
    const left = Math.max(
      MENU_MARGIN,
      Math.min(rect.left + 10, window.innerWidth - width - MENU_MARGIN),
    );
    const originX = Math.max(14, Math.min(width - 14, rect.left + 26 - left));
    setMenu({
      chat,
      left,
      width,
      ...(below
        ? {
            top: rect.bottom + MENU_GAP,
            maxHeight: Math.max(160, spaceBelow),
          }
        : {
            bottom: window.innerHeight - rect.top + MENU_GAP,
            maxHeight: Math.max(160, spaceAbove),
          }),
      shift: below ? 6 : -6,
      origin: `${originX}px ${below ? "0%" : "100%"}`,
    });
    setMenuClosing(false);
    setConfirmingDelete(false);
    setPressedId(chat.id);
  };

  const startPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    chat: ChatMeta,
  ) => {
    if (!event.isPrimary || event.button !== 0) return;
    clearPress();
    // A suppression belongs to the click that follows its own release.
    suppressClick.current = null;
    setPressedId(chat.id);
    const timer = window.setTimeout(() => {
      const current = press.current;
      if (!current || current.chat.id !== chat.id) return;
      current.fired = true;
      // The menu waits for the finger to lift; this is the "it is armed" tap.
      void mobile.haptic();
    }, LONG_PRESS);
    press.current = {
      timer,
      x: event.clientX,
      y: event.clientY,
      chat,
      rect: event.currentTarget.getBoundingClientRect(),
      fired: false,
      moved: false,
    };
  };

  const movePress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (!current) return;
    // The drawer's own drag decides at 6px; anything past that is a gesture on
    // the drawer, not a press on the row.
    if (Math.abs(event.clientX - current.x) > 6 || Math.abs(event.clientY - current.y) > 6) {
      current.moved = true;
      setPressedId(null);
      if (!current.fired) clearPress();
    }
  };

  const endPress = () => {
    const current = press.current;
    clearPress();
    if (!current || !current.fired || current.moved) {
      setPressedId(null);
      return;
    }
    const chat = current.chat;
    suppressClick.current = chat.id;
    const rect = current.rect;
    // The menu opens a beat after the release, so the compatibility click the
    // release produces lands on the row (and is suppressed) instead of on an
    // item that appeared under the finger.
    if (menuTimer.current) window.clearTimeout(menuTimer.current);
    menuTimer.current = window.setTimeout(() => {
      menuTimer.current = null;
      showActions(chat, rect);
    }, 60);
  };

  const openChat = (chat: ChatMeta) => {
    const suppressed = suppressClick.current === chat.id;
    suppressClick.current = null;
    if (!suppressed) onSelectChat(chat.id);
  };

  const row = (chat: ChatMeta) => (
    <div className="drawer-chat-row" key={chat.id}>
      <button
        className="drawer-chat"
        data-active={chat.id === activeId || undefined}
        data-pressed={
          chat.id === pressedId || chat.id === menu?.chat.id || undefined
        }
        aria-label={`${chat.title}, ${when(chat.updatedAt)}`}
        onClick={() => openChat(chat)}
        onPointerDown={(event) => startPress(event, chat)}
        onPointerMove={movePress}
        onPointerUp={endPress}
        onPointerCancel={() => {
          clearPress();
          setPressedId(null);
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="drawer-chat-title">{chat.title}</span>
        <span className="drawer-chat-time">{when(chat.updatedAt)}</span>
      </button>
      {/* The long press is not reachable with VoiceOver, so the same actions
          keep a labelled control in the tree without drawing a menu button. */}
      <button
        className="drawer-chat-actions"
        aria-label={`Chat actions for ${chat.title}`}
        onClick={(event) => {
          const visible = event.currentTarget
            .closest(".drawer-chat-row")
            ?.querySelector(".drawer-chat");
          showActions(
            chat,
            visible?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect(),
          );
        }}
      />
    </div>
  );

  const accountName = auth?.name ?? auth?.email ?? "Hook account";
  const initial = accountName.trim().slice(0, 1).toUpperCase();
  const plan = planName(settings?.plan ?? auth?.plan);

  return (
    <>
      <div
        className="chat-drawer-backdrop"
        data-open={open || dragging || undefined}
        data-dragging={dragging || undefined}
        style={backdropStyle}
        aria-hidden="true"
        {...backdropProps}
      />
      <aside
        className="chat-drawer"
        data-open={open || dragging || undefined}
        data-dragging={dragging || undefined}
        style={style}
        aria-hidden={!open && !dragging}
        aria-label="Chats"
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

      {menu ? (
        <div
          className="chat-menu-backdrop"
          data-closing={menuClosing || undefined}
          aria-hidden="true"
          onMouseDown={closeMenu}
        >
          <div
            className="chat-menu"
            data-closing={menuClosing || undefined}
            role="menu"
            aria-label={`Actions for ${menu.chat.title}`}
            style={
              {
                left: menu.left,
                width: menu.width,
                top: menu.top,
                bottom: menu.bottom,
                maxHeight: menu.maxHeight,
                transformOrigin: menu.origin,
                "--menu-shift": `${menu.shift}px`,
              } as CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="chat-menu-head">
              <div className="chat-menu-title">{menu.chat.title}</div>
              <div className="chat-menu-note">{when(menu.chat.updatedAt)}</div>
            </div>
            <div className="chat-menu-rule" />
            <button
              className="chat-menu-item"
              role="menuitem"
              onClick={() => {
                void togglePinned(menu.chat.id, !menu.chat.pinned);
                closeMenu();
              }}
            >
              {menu.chat.pinned ? (
                <PinOff strokeWidth={1.8} />
              ) : (
                <Pin strokeWidth={1.8} />
              )}
              {menu.chat.pinned ? "Unpin from the top" : "Pin to the top"}
            </button>
            <button
              className="chat-menu-item"
              role="menuitem"
              onClick={() => {
                setName(menu.chat.title);
                setRenaming(menu.chat);
                closeMenu();
              }}
            >
              <Pencil strokeWidth={1.8} />
              Rename
            </button>
            {menu.chat.remote ? (
              <button className="chat-menu-item" role="menuitem" disabled>
                <SquareTerminal strokeWidth={1.8} />
                Lives on {menu.chat.deviceName ?? "another machine"}
              </button>
            ) : null}
            <div className="chat-menu-rule" />
            <button
              className="chat-menu-item"
              data-danger="true"
              role="menuitem"
              disabled={
                menu.chat.remote &&
                devices?.find((device) => device.id === menu.chat.deviceId)?.hostOnline === false
              }
              onClick={() => {
                if (!confirmingDelete) {
                  // A phone deletes with a thumb, so the second tap is the
                  // confirmation: there is nowhere for an undo toast.
                  setConfirmingDelete(true);
                  return;
                }
                void removeChat(menu.chat.id);
                closeMenu();
              }}
            >
              <Trash2 strokeWidth={1.8} />
              {confirmingDelete
                ? menu.chat.remote
                  ? `Delete on ${
                      devices?.find((device) => device.id === menu.chat.deviceId)?.name ??
                      menu.chat.deviceName ??
                      "that machine"
                    }`
                  : "Delete permanently"
                : "Delete"}
            </button>
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
