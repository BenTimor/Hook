import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Ellipsis,
  FolderOpen,
  FolderInput,
  Pencil,
  Pin,
  PinOff,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { api } from "../lib/bridge";
import type { ChatMeta } from "../lib/types";
import { isCodingChat } from "../lib/utils";
import { useChatStore } from "../store/useChatStore";

interface Props {
  chat: ChatMeta;
  active: boolean;
  streaming: boolean;
}

export function ChatRow({ chat, active, streaming }: Props) {
  const select = useChatStore((s) => s.select);
  const rename = useChatStore((s) => s.rename);
  const togglePin = useChatStore((s) => s.togglePin);
  const remove = useChatStore((s) => s.remove);
  const changeCodingFolder = useChatStore((s) => s.changeCodingFolder);

  const coding = isCodingChat(chat);

  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const cancelled = useRef(false);

  const beginRename = () => {
    cancelled.current = false;
    setTitle(chat.title);
    setRenaming(true);
  };

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = true;
      return;
    }
    setRenaming(false);
    const clean = title.trim();
    if (clean && clean !== chat.title) void rename(chat.id, clean);
  };

  return (
    <div
      className="row"
      role="button"
      tabIndex={0}
      data-active={active}
      data-menu-open={menuOpen}
      onClick={() => void select(chat.id)}
      onDoubleClick={beginRename}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void select(chat.id);
        }
      }}
    >
      {chat.pinned && <Pin className="row-pin" strokeWidth={2} />}
      {coding && (
        <span className="row-badge" title={`Coding agent — ${chat.projectPath ?? ""}`}>
          <SquareTerminal strokeWidth={2} />
        </span>
      )}

      {renaming ? (
        <input
          className="row-input"
          autoFocus
          value={title}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelled.current = true;
              setRenaming(false);
            }
          }}
        />
      ) : (
        <span className="row-title">{chat.title}</span>
      )}

      {streaming && <span className="row-live live-dot" />}

      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            className="row-tail"
            aria-label="Chat options"
            onClick={(event) => event.stopPropagation()}
          >
            <Ellipsis strokeWidth={1.9} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="menu"
            align="start"
            sideOffset={4}
            collisionPadding={10}
            onClick={(event) => event.stopPropagation()}
          >
            <DropdownMenu.Item className="menu-item" onSelect={() => void togglePin(chat.id)}>
              {chat.pinned ? <PinOff strokeWidth={1.8} /> : <Pin strokeWidth={1.8} />}
              {chat.pinned ? "Unpin" : "Pin to top"}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="menu-item"
              onSelect={() => {
                beginRename();
              }}
            >
              <Pencil strokeWidth={1.8} />
              Rename
            </DropdownMenu.Item>
            {coding && (
              <>
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={() => void changeCodingFolder(chat.id)}
                >
                  <FolderInput strokeWidth={1.8} />
                  Change folder…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={() => {
                    if (chat.projectPath) void api.openPath(chat.projectPath);
                  }}
                >
                  <FolderOpen strokeWidth={1.8} />
                  Open folder
                </DropdownMenu.Item>
              </>
            )}
            <DropdownMenu.Separator className="menu-sep" />
            <DropdownMenu.Item
              className="menu-item"
              data-danger="true"
              onSelect={() => void remove(chat.id)}
            >
              <Trash2 strokeWidth={1.8} />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
