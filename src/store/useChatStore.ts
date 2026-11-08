import { create } from "zustand";
import { toast } from "sonner";

import { api } from "../lib/bridge";
import type { AppInfo, ChatMeta, Message, StreamEvent } from "../lib/types";
import { sortMetas, upsertMeta } from "../lib/utils";

type StreamState = { messageId: string; text: string };

interface ChatStore {
  info: AppInfo | null;
  ready: boolean;
  chats: ChatMeta[];
  activeId: string | null;
  messages: Message[];
  streams: Record<string, StreamState>;
  draft: string;
  sidebarOpen: boolean;
  focusToken: number;
  searchToken: number;

  bootstrap: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  newChat: () => void;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  regenerate: () => Promise<void>;
  edit: (messageId: string, text: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  setDraft: (value: string) => void;
  focusComposer: () => void;
  toggleSidebar: () => void;
  requestSearch: () => void;
}

function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function settle(messages: Message[], streaming: boolean): Message[] {
  if (streaming) return messages;
  return messages.map((m) => (m.status === "streaming" ? { ...m, status: "aborted" } : m));
}

let deltaQueue: Record<string, string> = {};
let rafId = 0;
let booting = false;

export const useChatStore = create<ChatStore>((set, get) => {
  const flushDeltas = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const queued = deltaQueue;
      deltaQueue = {};
      set((state) => {
        const streams = { ...state.streams };
        let touched = false;
        for (const [chatId, text] of Object.entries(queued)) {
          const prev = streams[chatId];
          if (!prev) continue;
          streams[chatId] = { messageId: prev.messageId, text: prev.text + text };
          touched = true;
        }
        return touched ? { streams } : {};
      });
    });
  };

  const streamHandler = (ownerChatId: string | null) => {
    let chatId = ownerChatId;
    return (event: StreamEvent) => {
      switch (event.kind) {
        case "started": {
          chatId = event.meta.id;
          const streaming = [...event.messages].reverse().find((m) => m.status === "streaming");
          set((state) => ({
            activeId: event.meta.id,
            messages: event.messages,
            chats: upsertMeta(state.chats, event.meta),
            draft: "",
            streams: streaming
              ? { ...state.streams, [event.meta.id]: { messageId: streaming.id, text: "" } }
              : state.streams,
          }));
          break;
        }
        case "delta": {
          if (!chatId) break;
          if (!get().streams[chatId]) break;
          deltaQueue[chatId] = (deltaQueue[chatId] ?? "") + event.text;
          flushDeltas();
          break;
        }
        case "done": {
          const id = event.meta.id;
          set((state) => {
            const streams = { ...state.streams };
            delete streams[id];
            return {
              streams,
              chats: upsertMeta(state.chats, event.meta),
              ...(state.activeId === id
                ? { messages: settle(event.messages, false) }
                : {}),
            };
          });
          break;
        }
        case "error": {
          const id = event.meta.id;
          set((state) => {
            const streams = { ...state.streams };
            delete streams[id];
            return {
              streams,
              chats: upsertMeta(state.chats, event.meta),
              ...(state.activeId === id
                ? { messages: settle(event.messages, false) }
                : {}),
            };
          });
          // The inline error already covers the chat the user is looking at.
          if (get().activeId !== id) toast.error(event.message, { duration: 6000 });
          break;
        }
      }
    };
  };

  return {
    info: null,
    ready: false,
    chats: [],
    activeId: null,
    messages: [],
    streams: {},
    draft: "",
    sidebarOpen: true,
    focusToken: 0,
    searchToken: 0,

    bootstrap: async () => {
      if (booting) return;
      booting = true;
      try {
        const [info, chats] = await Promise.all([api.appInfo(), api.listChats()]);
        set({ info, chats: sortMetas(chats), ready: true });

        // Design-time deep link used by the browser preview only.
        const params = new URLSearchParams(window.location.search);
        const demoChat = params.get("chat");
        if (demoChat) await get().select(demoChat);
        const demoText = params.get("send");
        if (demoText) await get().send(demoText);
      } catch (error) {
        set({ ready: true });
        toast.error(textOf(error));
      }
    },

    select: async (id) => {
      if (get().activeId === id) return;
      if (id === null) {
        set({ activeId: null, messages: [] });
        return;
      }
      try {
        const chat = await api.getChat(id);
        set({
          activeId: id,
          messages: settle(chat.messages, Boolean(get().streams[id])),
        });
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    newChat: () =>
      set((state) => ({
        activeId: null,
        messages: [],
        draft: "",
        focusToken: state.focusToken + 1,
      })),

    send: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const { activeId } = get();
      if (activeId && get().streams[activeId]) return;
      set({ draft: "" });
      try {
        await api.sendMessage(activeId, trimmed, streamHandler(activeId));
      } catch (error) {
        set({ draft: trimmed });
        toast.error(textOf(error));
      }
    },

    stop: async () => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        await api.stopStream(activeId);
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    regenerate: async () => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        await api.regenerate(activeId, streamHandler(activeId));
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    edit: async (messageId, text) => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        await api.editMessage(activeId, messageId, text, streamHandler(activeId));
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    rename: async (id, title) => {
      const clean = title.trim();
      if (!clean) return;
      const previous = get().chats;
      set({
        chats: sortMetas(
          previous.map((c) => (c.id === id ? { ...c, title: clean } : c)),
        ),
      });
      try {
        const meta = await api.renameChat(id, clean);
        set((state) => ({ chats: upsertMeta(state.chats, meta) }));
      } catch (error) {
        set({ chats: previous });
        toast.error(textOf(error));
      }
    },

    togglePin: async (id) => {
      const chat = get().chats.find((c) => c.id === id);
      if (!chat) return;
      try {
        const meta = await api.setPinned(id, !chat.pinned);
        set((state) => ({ chats: upsertMeta(state.chats, meta) }));
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    remove: async (id) => {
      const previous = get().chats;
      const wasActive = get().activeId === id;
      set((state) => {
        const streams = { ...state.streams };
        delete streams[id];
        return {
          chats: state.chats.filter((c) => c.id !== id),
          streams,
          ...(wasActive ? { activeId: null, messages: [] } : {}),
        };
      });
      try {
        await api.deleteChat(id);
      } catch (error) {
        set({ chats: previous });
        toast.error(textOf(error));
        return;
      }
      toast("Chat deleted", {
        duration: 6000,
        action: { label: "Undo", onClick: () => void get().restore(id) },
      });
    },

    restore: async (id) => {
      try {
        const meta = await api.restoreChat(id);
        set((state) => ({ chats: upsertMeta(state.chats, meta) }));
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    setDraft: (value) => set({ draft: value }),

    focusComposer: () => set((state) => ({ focusToken: state.focusToken + 1 })),

    toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

    requestSearch: () => set((state) => ({ searchToken: state.searchToken + 1 })),
  };
});
