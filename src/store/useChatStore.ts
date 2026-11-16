import { create } from "zustand";
import { toast } from "sonner";

import {
  api,
  onAgentsEvent,
  onAuthEvent,
  onChatEvent,
  onPreviewEvent,
  onSyncEvent,
} from "../lib/bridge";
import type {
  AgentsOverview,
  AppInfo,
  AuthView,
  ChatMeta,
  DraftImage,
  Message,
  PreviewView,
  SettingsView,
  StreamEvent,
} from "../lib/types";
import { sortMetas, upsertMeta } from "../lib/utils";

type StreamState = { messageId: string; text: string };

interface ChatStore {
  info: AppInfo | null;
  ready: boolean;
  /** Who is signed in. Null until the first status call finishes. */
  auth: AuthView | null;
  authBusy: boolean;
  authError: string | null;
  chats: ChatMeta[];
  activeId: string | null;
  messages: Message[];
  streams: Record<string, StreamState>;
  draft: string;
  /** Pictures staged for the next message in the active chat. */
  draftImages: DraftImage[];
  addDraftImages: (images: DraftImage[]) => void;
  removeDraftImage: (id: string) => void;
  clearDraftImages: () => void;
  sidebarOpen: boolean;
  focusToken: number;
  searchToken: number;
  /** A brand new chat is being created by the first send. */
  pendingNewChat: boolean;
  agents: AgentsOverview;
  /** The page the preview panel is showing, or null when nothing is open. */
  preview: PreviewView | null;
  /** The user's choice for the right-side panel; auto-opens the first time a run shows one. */
  previewOpen: boolean;
  settings: SettingsView | null;
  settingsOpen: boolean;

  bootstrap: () => Promise<void>;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshAuth: () => Promise<void>;
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
  togglePreview: () => void;
  setPreviewOpen: (open: boolean) => void;
  requestSearch: () => void;
  openSettings: () => Promise<void>;
  closeSettings: () => void;
  refreshSettings: () => Promise<void>;
  chooseProjectsDir: () => Promise<void>;
  /** Stop every coding agent working in the active chat, right now. */
  stopChatAgents: () => Promise<void>;
}

function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** Tool traffic and agent notes live in history but never on screen. */
function visible(messages: Message[]): Message[] {
  return messages.filter(
    (m) => !m.hidden && m.role !== "tool" && m.role !== "system",
  );
}

function settle(messages: Message[], streaming: boolean): Message[] {
  const shown = visible(messages);
  if (streaming) return shown;
  return shown.map((m) => (m.status === "streaming" ? { ...m, status: "aborted" } : m));
}

let deltaQueue: Record<string, string> = {};
let rafId = 0;
let booting = false;
let unsubscribe: (() => void) | null = null;
let unsubscribeAuth: (() => void) | null = null;
let unsubscribeSync: (() => void) | null = null;

export const useChatStore = create<ChatStore>((set, get) => {
  /** Load everything that belongs to the signed-in window. */
  const loadWorkspace = async () => {
    const [info, chats, agents, preview] = await Promise.all([
      api.appInfo(),
      api.listChats(),
      api.agentsOverview(),
      api.previewState(),
    ]);
    set({
      info,
      chats: sortMetas(chats),
      ready: true,
      agents,
      preview,
      previewOpen: Boolean(preview?.active),
    });
  };

  const clearWorkspace = () => {
    set({
      chats: [],
      activeId: null,
      messages: [],
      streams: {},
      draft: "",
      draftImages: [],
      pendingNewChat: false,
      agents: { working: 0, live: 0, agents: [] },
      preview: null,
      previewOpen: false,
      settings: null,
      settingsOpen: false,
    });
  };

  const handleAuth = (view: AuthView) => {
    const wasSignedIn = Boolean(get().auth?.signedIn);
    set({
      auth: view,
      authBusy: view.state === "pending",
      authError: view.message,
    });
    if (view.message && view.state !== "signed_out") toast.error(view.message);
    if (!view.signedIn) {
      clearWorkspace();
      return;
    }
    if (!wasSignedIn) {
      void loadWorkspace().catch((error) => toast.error(textOf(error)));
    }
  };

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

  const handleEvent = (chatId: string, event: StreamEvent) => {
    switch (event.kind) {
      case "started": {
        const streaming = [...event.messages]
          .reverse()
          .find((m) => m.status === "streaming");
        set((state) => {
          const shows = state.activeId === chatId || state.pendingNewChat;
          return {
            chats: upsertMeta(state.chats, event.meta),
            streams: streaming
              ? {
                  ...state.streams,
                  [chatId]: { messageId: streaming.id, text: "" },
                }
              : state.streams,
            ...(shows
              ? {
                  activeId: chatId,
                  messages: visible(event.messages),
                  pendingNewChat: false,
                }
              : {}),
          };
        });
        break;
      }
      case "delta": {
        if (!get().streams[chatId]) break;
        deltaQueue[chatId] = (deltaQueue[chatId] ?? "") + event.text;
        flushDeltas();
        break;
      }
      case "done": {
        set((state) => {
          const streams = { ...state.streams };
          delete streams[chatId];
          return {
            streams,
            chats: upsertMeta(state.chats, event.meta),
            ...(state.activeId === chatId
              ? { messages: settle(event.messages, false) }
              : {}),
          };
        });
        break;
      }
      case "error": {
        set((state) => {
          const streams = { ...state.streams };
          delete streams[chatId];
          return {
            streams,
            chats: upsertMeta(state.chats, event.meta),
            ...(state.activeId === chatId
              ? { messages: settle(event.messages, false) }
              : {}),
          };
        });
        // The inline error already covers the chat the user is looking at.
        if (get().activeId !== chatId) toast.error(event.message, { duration: 6000 });
        break;
      }
    }
  };

  return {
    info: null,
    ready: false,
    auth: null,
    authBusy: false,
    authError: null,
    chats: [],
    activeId: null,
    messages: [],
    streams: {},
    draft: "",
    draftImages: [],
    sidebarOpen: true,
    focusToken: 0,
    searchToken: 0,
    pendingNewChat: false,
    agents: { working: 0, live: 0, agents: [] },
    preview: null,
    previewOpen: false,
    settings: null,
    settingsOpen: false,

    bootstrap: async () => {
      if (booting) return;
      booting = true;

      unsubscribe?.();
      unsubscribe = onChatEvent(handleEvent);
      unsubscribeAuth?.();
      unsubscribeAuth = onAuthEvent(handleAuth);
      unsubscribeSync?.();
      unsubscribeSync = onSyncEvent((event) => {
        if (event.projects) void get().refreshSettings();
        if (!event.chats) return;
        const activeId = get().activeId;
        void api
          .listChats()
          .then((chats) => {
            set({ chats: sortMetas(chats) });
            if (!activeId || get().streams[activeId]) return;
            void api
              .getChat(activeId)
              .then((chat) => {
                if (get().activeId === activeId && !get().streams[activeId])
                  set({ messages: chat.messages });
              })
              .catch(() => {
                // It was deleted on another computer.
                if (get().activeId === activeId)
                  set({ activeId: null, messages: [] });
              });
          })
          .catch(() => {});
      });
      // Returning to the window is a good moment to catch up: the other
      // computer may have written while this one was in the background.
      window.addEventListener("focus", () => void api.syncNow());
      onAgentsEvent((overview) => set({ agents: overview }));
      onPreviewEvent((preview) => {
        if (!preview.active) {
          set({ preview: null, previewOpen: false });
          return;
        }
        set((state) => ({
          preview,
          // Only the first show in a run opens the panel; later page switches,
          // refreshes and the run settling leave the user's choice alone.
          previewOpen: preview.open ? true : state.previewOpen,
        }));
      });

      try {
        const auth = await api.authStatus();
        set({ auth, authBusy: auth.state === "pending" });
        if (!auth.signedIn) {
          set({ ready: true });
          return;
        }
        await loadWorkspace();

        // Design-time deep link used by the browser preview only.
        const params = new URLSearchParams(window.location.search);
        const demoChat = params.get("chat");
        if (demoChat) await get().select(demoChat);
        const demoText = params.get("send");
        if (demoText) await get().send(demoText);

        // A cached login may have been revoked while Hook was closed.
        void get().refreshAuth();
      } catch (error) {
        const message = textOf(error);
        if (get().auth?.signedIn) {
          // The account is fine; a workspace command failed. Keep the window
          // usable and let the user retry rather than showing the login screen.
          set({ ready: true });
        } else {
          set({
            ready: true,
            auth: {
              signedIn: false,
              state: "signed_out",
              email: null,
              name: null,
              userCode: null,
              verificationUrl: null,
              message,
            },
            authError: message,
          });
        }
        toast.error(message);
      }
    },

    signIn: async () => {
      if (get().authBusy) return;
      set({ authBusy: true, authError: null });
      try {
        const auth = await api.authLogin();
        set({
          auth,
          authBusy: auth.state === "pending",
          authError: auth.message,
        });
      } catch (error) {
        const message = textOf(error);
        set({ authBusy: false, authError: message });
        toast.error(message);
      }
    },

    cancelSignIn: async () => {
      try {
        const auth = await api.authCancelLogin();
        set({ auth, authBusy: false, authError: null });
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    signOut: async () => {
      set({ authBusy: true });
      try {
        const auth = await api.authLogout();
        handleAuth(auth);
      } catch (error) {
        toast.error(textOf(error));
      } finally {
        set({ authBusy: false });
      }
    },

    refreshAuth: async () => {
      try {
        const auth = await api.authRefresh();
        handleAuth(auth);
      } catch (error) {
        // A network blip should not hide a working cached session.
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
      if (!get().auth?.signedIn) {
        toast.error("Sign in to Hook to send messages.");
        return;
      }
      const trimmed = text.trim();
      const images = get().draftImages;
      if (!trimmed && images.length === 0) return;
      const { activeId } = get();
      if (activeId && get().streams[activeId]) return;
      set({ draft: "", draftImages: [], pendingNewChat: !activeId });
      try {
        const id = await api.sendMessage(
          activeId,
          trimmed,
          images.map(({ dataUrl, width, height }) => ({ dataUrl, width, height })),
        );
        if (!activeId) set({ activeId: id });
      } catch (error) {
        set({ draft: trimmed, draftImages: images, pendingNewChat: false });
        toast.error(textOf(error));
      }
    },

    addDraftImages: (images) =>
      set((state) => ({ draftImages: [...state.draftImages, ...images].slice(0, 6) })),

    removeDraftImage: (id) =>
      set((state) => ({ draftImages: state.draftImages.filter((image) => image.id !== id) })),

    clearDraftImages: () => set({ draftImages: [] }),

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
        await api.regenerate(activeId);
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    edit: async (messageId, text) => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        await api.editMessage(activeId, messageId, text);
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

    togglePreview: () =>
      set((state) => (state.preview ? { previewOpen: !state.previewOpen } : {})),

    setPreviewOpen: (open) => set({ previewOpen: open }),

    requestSearch: () => set((state) => ({ searchToken: state.searchToken + 1 })),

    openSettings: async () => {
      set({ settingsOpen: true });
      await get().refreshSettings();
    },

    closeSettings: () => set({ settingsOpen: false }),

    refreshSettings: async () => {
      try {
        const settings = await api.getSettings();
        set({ settings });
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    chooseProjectsDir: async () => {
      try {
        const picked = await api.pickFolder();
        if (!picked) return;
        const settings = await api.setProjectsDir(picked);
        set({ settings });
        toast.success("Projects folder updated");
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    stopChatAgents: async () => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        const overview = await api.stopChatAgents(activeId);
        set({ agents: overview });
        toast("Coding agent stopped", { duration: 4000 });
      } catch (error) {
        toast.error(textOf(error));
      }
    },
  };
});
