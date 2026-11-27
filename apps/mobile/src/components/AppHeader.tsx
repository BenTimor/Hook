import { Menu, SquarePen } from "lucide-react";

import { HookMark } from "@hook/ui";

/**
 * The phone's one top bar.
 *
 * The conversation, the welcome screen and Workspace all stand under it, so the
 * drawer and New chat are never a screen away. The brand is a real grid cell
 * between two fixed buttons: it stays centred whether the subtitle is there or
 * not.
 */
export function AppHeader({
  onMenu,
  onNewChat,
  subtitle,
}: {
  onMenu: () => void;
  onNewChat: () => void;
  subtitle?: string | null;
}) {
  return (
    <header className="app-header">
      <button
        className="app-header-btn"
        title="Open chats"
        aria-label="Open chats"
        onClick={onMenu}
      >
        <Menu strokeWidth={1.9} />
      </button>

      <div className="app-header-center">
        <div className="app-header-brand">
          <HookMark />
          <span>Hook</span>
        </div>
        {subtitle ? <span className="app-header-sub">{subtitle}</span> : null}
      </div>

      <button
        className="app-header-btn"
        title="New chat"
        aria-label="New chat"
        onClick={onNewChat}
      >
        <SquarePen strokeWidth={1.9} />
      </button>
    </header>
  );
}
