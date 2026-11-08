import { useState } from "react";
import { PanelLeft } from "lucide-react";

import { win } from "../lib/bridge";
import { modKey } from "../lib/utils";
import { useChatStore } from "../store/useChatStore";
import { AgentPill } from "./AgentPill";
import { WindowControls } from "./WindowControls";

export function PaneHead() {
  const activeId = useChatStore((s) => s.activeId);
  const title = useChatStore(
    (s) => s.chats.find((c) => c.id === s.activeId)?.title ?? "New chat",
  );
  const rename = useChatStore((s) => s.rename);
  const open = useChatStore((s) => s.sidebarOpen);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);

  const commit = () => {
    setEditing(false);
    if (activeId && value.trim() && value.trim() !== title) void rename(activeId, value);
  };

  return (
    <div
      className="pane-head"
      data-tauri-drag-region
      onDoubleClick={() => void win.toggleMaximize()}
    >
      {!open && (
        <button className="icon-btn" title={`Show sidebar (${modKey}B)`} onClick={toggleSidebar}>
          <PanelLeft strokeWidth={1.8} />
        </button>
      )}

      {editing ? (
        <input
          className="pane-title-input"
          autoFocus
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <div
          className="pane-title"
          data-tauri-drag-region
          data-editable={Boolean(activeId)}
          title={activeId ? "Double-click to rename" : undefined}
          onDoubleClick={
            activeId
              ? (event) => {
                  event.stopPropagation();
                  setValue(title);
                  setEditing(true);
                }
              : undefined
          }
        >
          {title}
        </div>
      )}

      <div className="spacer" />
      <AgentPill />
      <WindowControls />
    </div>
  );
}
