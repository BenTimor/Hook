import { useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  Laptop,
  Pin,
  Plus,
  Search,
  Settings2,
  SquareTerminal,
  X,
} from "lucide-react";

import { api } from "../lib/bridge";
import type { SearchHit } from "../lib/types";
import { groupChats, isCodingChat, modKey } from "../lib/utils";
import { useChatStore } from "../store/useChatStore";
import { isLiveAgent } from "../lib/agents";
import { AgentTree } from "./AgentTree";
import { ChatRow } from "./ChatRow";
import { HookMark } from "@hook/ui";
import { RemoteChatDialog } from "@hook/chat";

export function Sidebar() {
  const chats = useChatStore((s) => s.chats);
  const activeId = useChatStore((s) => s.activeId);
  const streams = useChatStore((s) => s.streams);
  const activity = useChatStore((s) => s.activity);
  const agents = useChatStore((s) => s.agents.agents);
  const select = useChatStore((s) => s.select);
  const newChat = useChatStore((s) => s.newChat);
  const newCodingChat = useChatStore((s) => s.newCodingChat);
  const newRemoteCodingChat = useChatStore((s) => s.newRemoteCodingChat);
  const devices = useChatStore((s) => s.devices);
  const info = useChatStore((s) => s.info);
  const open = useChatStore((s) => s.sidebarOpen);
  const searchToken = useChatStore((s) => s.searchToken);
  const advanced = useChatStore((s) => Boolean(s.settings?.advancedMode));
  // Coding agents need a paid plan, or this account's own model endpoint. The
  // backend refuses either way; hiding the door is the honest UI.
  const settings = useChatStore((s) => s.settings);
  const codingAllowed =
    settings?.plan !== "free" || Boolean(settings?.customProvider);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const openSettings = useChatStore((s) => s.openSettings);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchToken > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [searchToken]);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void api
        .searchChats(needle)
        .then((results) => {
          if (alive) setHits(results);
        })
        .catch(() => {
          if (alive) setHits([]);
        });
    }, 130);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  // Coding-agent conversations are part of the advanced view: turning it off
  // hides them from the list, and back on brings them back. Nothing is deleted.
  const visibleChats = useMemo(
    () => (advanced ? chats : chats.filter((chat) => !isCodingChat(chat))),
    [chats, advanced],
  );
  const visibleHits = useMemo(
    () => (hits === null ? null : advanced ? hits : hits.filter((hit) => !isCodingChat(hit.chat))),
    [hits, advanced],
  );
  const listGroups = useMemo(() => groupChats(visibleChats), [visibleChats]);
  const workingChats = useMemo(
    () =>
      new Set(
        agents
          .filter(isLiveAgent)
          .map((agent) => agent.chatId),
      ),
    [agents],
  );

  return (
    <aside className="sidebar" data-collapsed={!open}>
      <div className="sidebar-head">
        <div className="wordmark" data-tauri-drag-region>
          <HookMark />
          Hook
        </div>
        <button className="icon-btn" title={`Hide sidebar (${modKey}B)`} onClick={toggleSidebar}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect
              x="1.75"
              y="2.75"
              width="12.5"
              height="10.5"
              rx="2.5"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path d="M6 3v10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>

      <div className="sidebar-actions">
        <div className="new-chat-row">
          <button className="nav-btn" onClick={newChat}>
            <Plus strokeWidth={2} />
            New chat
            <span className="kbd">{modKey}N</span>
          </button>
          {advanced && codingAllowed && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  className="nav-btn-caret"
                  title="Other ways to start"
                  aria-label="Other ways to start"
                >
                  <ChevronDown strokeWidth={2} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="menu"
                  align="end"
                  sideOffset={4}
                  collisionPadding={10}
                >
                  <DropdownMenu.Item className="menu-item" onSelect={newChat}>
                    <Plus strokeWidth={1.8} />
                    New chat
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="menu-item"
                    onSelect={() => void newCodingChat()}
                  >
                    <SquareTerminal strokeWidth={1.8} />
                    Coding agent…
                  </DropdownMenu.Item>
                  {settings?.plan !== "free" && (
                    <DropdownMenu.Item
                      className="menu-item"
                      onSelect={() => setRemoteOpen(true)}
                    >
                      <Laptop strokeWidth={1.8} />
                      Coding agent on another machine…
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
        <div className="search-field">
          <Search strokeWidth={1.9} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search chats"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
                event.currentTarget.blur();
              }
            }}
          />
          {query ? (
            <button
              className="icon-btn"
              style={{ width: 18, height: 18 }}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X strokeWidth={2} />
            </button>
          ) : (
            <span className="kbd">{modKey}K</span>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {visibleHits !== null ? (
          visibleHits.length ? (
            visibleHits.map((hit) => (
              <button
                key={hit.chat.id}
                className="result"
                data-active={hit.chat.id === activeId}
                onClick={() => {
                  void select(hit.chat.id);
                  setQuery("");
                }}
              >
                <span className="result-title">
                  {hit.chat.pinned && <Pin className="row-pin" strokeWidth={2} />}
                  {isCodingChat(hit.chat) && (
                    <SquareTerminal className="row-badge" strokeWidth={2} />
                  )}
                  {hit.chat.title}
                </span>
                <span className="hit-snippet">{hit.snippet}</span>
              </button>
            ))
          ) : (
            <div className="sidebar-empty">No matches for “{query.trim()}”</div>
          )
        ) : listGroups.length ? (
          listGroups.map((group) => (
            <div key={group.label}>
              <div className="group-label">{group.label}</div>
              {group.chats.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  active={chat.id === activeId}
                  streaming={
                    Boolean(streams[chat.id] || activity[chat.id]) ||
                    workingChats.has(chat.id)
                  }
                />
              ))}
            </div>
          ))
        ) : (
          <div className="sidebar-empty">
            No conversations yet.
            <br />
            Ask something to start one.
          </div>
        )}

        {advanced && <AgentTree />}
      </div>

      <div className="sidebar-foot">
        <button
          className="foot-btn"
          onClick={() => void openSettings()}
          title="Settings"
        >
          <Settings2 strokeWidth={1.9} />
          Settings
        </button>
        <span className="grow" />
        <span>v{info?.version ?? "0.1.0"}</span>
      </div>

      {remoteOpen && (
        <RemoteChatDialog
          devices={devices?.devices ?? []}
          selfId={devices?.selfId ?? ""}
          onClose={() => setRemoteOpen(false)}
          loadProjects={api.remoteProjects}
          createProject={api.createRemoteProject}
          loadFolders={api.remoteFolders}
          pinFolder={api.pinRemoteFolder}
          onCreate={(deviceId, target) =>
            newRemoteCodingChat(deviceId, target)
          }
        />
      )}
    </aside>
  );
}
