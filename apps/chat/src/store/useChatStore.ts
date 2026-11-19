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
import { sortMetas, upsertMeta, isCodingChat } from "../lib/utils";

type StreamState = { messageId: string; text: string; reasoning: string };

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
  /**
   * What each running turn is doing, oldest label first. The store only keeps
   * the record; `TurnActivity` paces it. A chat with an entry is running even
   * while no text is arriving, which is the whole point: a tool has the floor.
   */
  activity: Record<string, string[]>;
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
  /** The coding agent whose transcript the inspector is showing, if any. */
  inspectAgentId: string | null;

  bootstrap: () => Promise<void>;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  newChat: () => void;
  /**
   * Start a coding-agent conversation: pick a folder, then talk to the engine
   * in it. Advanced mode only; the backend refuses otherwise.
   */
  newCodingChat: () => Promise<void>;
  /** Point a coding chat at another folder (a moved or renamed project). */
  changeCodingFolder: (id: string) => Promise<void>;
  /** Answer a question the active coding agent is blocked on. */
  answerAgent: (answer: string) => Promise<void>;
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
  setAdvancedMode: (enabled: boolean) => Promise<void>;
  /** Open or close the read-only coding-agent inspector. */
  inspectAgent: (id: string | null) => void;
  /** Reload the sidebar after something wrote chats outside a turn. */
  refreshChats: () => Promise<void>;
  chooseProjectsDir: () => Promise<void>;
  /** Stop every coding agent working in the active chat, right now. */
  stopChatAgents: () => Promise<void>;
}

function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** System frames live in history but never on screen. The thread decides what
 * else advanced mode may show, so tool traffic is kept here for it to use. */
function visible(messages: Message[]): Message[] {
  return messages.filter((m) => m.role !== "system");
}

function settle(messages: Message[], streaming: boolean): Message[] {
  const shown = visible(messages);
  if (streaming) return shown;
  return shown.map((m) => (m.status === "streaming" ? { ...m, status: "aborted" } : m));
}

let deltaQueue: Record<string, string> = {};
let reasoningQueue: Record<string, string> = {};
let rafId = 0;
let booting = false;
let unsubscribe: (() => void) | null = null;
let unsubscribeAuth: (() => void) | null = null;
let unsubscribeSync: (() => void) | null = null;

export const useChatStore = create<ChatStore>((set, get) => {
  /** Load everything that belongs to the signed-in window. */
  const loadWorkspace = async () => {
    const [info, chats, agents, preview, settings] = await Promise.all([
      api.appInfo(),
      api.listChats(),
      api.agentsOverview(),
      api.previewState(),
      api.getSettings(),
    ]);
    set({
      info,
      chats: sortMetas(chats),
      ready: true,
      agents,
      preview,
      previewOpen: Boolean(preview?.active),
      // Loaded at boot so advanced mode (and the projects folder) survives a
      // restart instead of waiting for Settings to be opened.
      settings,
    });
  };

  const clearWorkspace = () => {
    set({
      chats: [],
      activeId: null,
      messages: [],
      streams: {},
      activity: {},
      draft: "",
      draftImages: [],
      pendingNewChat: false,
      agents: { working: 0, live: 0, agents: [] },
      preview: null,
      previewOpen: false,
      settings: null,
      settingsOpen: false,
      inspectAgentId: null,
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
      const reasoning = reasoningQueue;
      deltaQueue = {};
      reasoningQueue = {};
      set((state) => {
        const streams = { ...state.streams };
        let touched = false;
        for (const [chatId, text] of Object.entries(queued)) {
          const prev = streams[chatId];
          if (!prev) continue;
          streams[chatId] = {
            messageId: prev.messageId,
            text: prev.text + text,
            reasoning: prev.reasoning,
          };
          touched = true;
        }
        for (const [chatId, text] of Object.entries(reasoning)) {
          const prev = streams[chatId];
          if (!prev) continue;
          streams[chatId] = {
            messageId: prev.messageId,
            text: prev.text,
            reasoning: prev.reasoning + text,
          };
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
            // A new turn opens the activity line with "Thinking"; the next
            // model call of the same turn leaves what is already queued.
            activity: state.activity[chatId]
              ? state.activity
              : { ...state.activity, [chatId]: [] },
            streams: streaming
              ? {
                  ...state.streams,
                  [chatId]: { messageId: streaming.id, text: "", reasoning: "" },
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
      case "activity": {
        const label = event.label;
        set((state) => {
          const activity = { ...state.activity };
          if (label === null) {
            delete activity[chatId];
          } else {
            activity[chatId] = [...(activity[chatId] ?? []), label];
          }
          return { activity };
        });
        break;
      }
      case "reasoning": {
        if (!get().streams[chatId]) break;
        reasoningQueue[chatId] = (reasoningQueue[chatId] ?? "") + event.text;
        flushDeltas();
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
          // A reply that ended in a tool call hands the turn to the next model
          // call, so the activity line keeps what it has. Anything else is the
          // end of the turn: drop the line here instead of waiting a frame for
          // the turn's final event to arrive.
          const last = [...event.messages]
            .reverse()
            .find((message) => message.role === "assistant");
          const activity = { ...state.activity };
          if (!last || !last.toolCalls?.length) delete activity[chatId];
          return {
            streams,
            activity,
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
          const activity = { ...state.activity };
          delete activity[chatId];
          return {
            streams,
            activity,
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
    activity: {},
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
    inspectAgentId: null,

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
            if (
              !activeId ||
              get().streams[activeId] ||
              get().activity[activeId]
            )
              return;
            void api
              .getChat(activeId)
              .then((chat) => {
                if (
                  get().activeId === activeId &&
                  !get().streams[activeId] &&
                  !get().activity[activeId]
                )
                  set({ messages: settle(chat.messages, false) });
              })
              .catch(() => {
                // It was deleted on another computer.
                if (get().activeId === activeId)
                  set({ activeId: null, messages: [], inspectAgentId: null });
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
        set({ activeId: null, messages: [], inspectAgentId: null });
        return;
      }
      try {
        const chat = await api.getChat(id);
        // Coding agents are part of the advanced view. The list already hides
        // them; this is the other half, for anything that still asks by name
        // (`?chat=`, a stale shortcut).
        if (isCodingChat(chat.meta) && !get().settings?.advancedMode) {
          toast.error("Turn on advanced mode to open a coding agent.");
          return;
        }
        set({
          activeId: id,
          // Moving to another chat ends the inspection. A finished run only
          // stays in the sidebar tree while the user is still looking at it.
          inspectAgentId: null,
          messages: settle(
            chat.messages,
            Boolean(get().streams[id] || get().activity[id]),
          ),
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
        inspectAgentId: null,
        focusToken: state.focusToken + 1,
      })),

    newCodingChat: async () => {
      if (!get().auth?.signedIn) {
        toast.error("Sign in to Hook to start a coding agent.");
        return;
      }
      const folder = await api.pickFolder("Choose a folder for the coding agent");
      if (!folder) return;
      try {
        const meta = await api.createCodingChat(folder);
        set((state) => ({
          chats: upsertMeta(state.chats, meta),
          activeId: meta.id,
          messages: [],
          draft: "",
          draftImages: [],
          inspectAgentId: null,
          focusToken: state.focusToken + 1,
        }));
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    changeCodingFolder: async (id) => {
      const chat = get().chats.find((entry) => entry.id === id);
      if (!isCodingChat(chat)) return;
      const folder = await api.pickFolder("Choose a folder for the coding agent");
      if (!folder) return;
      try {
        const meta = await api.setCodingChatFolder(id, folder);
        set((state) => ({ chats: upsertMeta(state.chats, meta) }));
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    answerAgent: async (answer) => {
      const { activeId } = get();
      if (!activeId || !answer.trim()) return;
      try {
        await api.answerCodingAgent(activeId, answer.trim());
      } catch (error) {
        toast.error(textOf(error));
      }
    },

    send: async (text) => {
      if (!get().auth?.signedIn) {
        toast.error("Sign in to Hook to send messages.");
        return;
      }
      const { activeId } = get();
      // A coding agent's conversation accepts a message while it is working:
      // that message steers the run instead of waiting for it.
      const coding = isCodingChat(get().chats.find((chat) => chat.id === activeId));
      const trimmed = text.trim();
      const images = coding ? [] : get().draftImages;
      if (!trimmed && images.length === 0) return;
      if (activeId && get().streams[activeId] && !coding) return;
      set({ draft: "", draftImages: [], pendingNewChat: !activeId });
      try {
        const id = await api.sendMessage(
          activeId,
          trimmed,
          images.map(({ dataUrl, width, height }) => ({ dataUrl, width, height })),
        );
        if (!activeId) set({ activeId: id, inspectAgentId: null });
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
        const activity = { ...state.activity };
        delete activity[id];
        return {
          chats: state.chats.filter((c) => c.id !== id),
          streams,
          activity,
          ...(wasActive ? { activeId: null, messages: [], inspectAgentId: null } : {}),
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

    setAdvancedMode: async (enabled) => {
      const previous = get().settings;
      // Paint the switch at once; the backend is what actually persists it.
      if (previous) set({ settings: { ...previous, advancedMode: enabled } });
      if (!enabled) {
        set({ inspectAgentId: null });
        // A coding-agent conversation is this switch's feature, and the simple
        // view cannot draw it: its turns are tool traffic, not one reply after
        // another, so it would read as empty bubbles that flash. Step back to
        // the empty pane instead. The chat itself is untouched and comes back
        // with the switch.
        if (isCodingChat(get().chats.find((chat) => chat.id === get().activeId))) {
          set({ activeId: null, messages: [] });
          toast.message("Coding agents are hidden while advanced mode is off.");
        }
      }
      try {
        const settings = await api.setAdvancedMode(enabled);
        set({ settings });
      } catch (error) {
        set({ settings: previous });
        toast.error(textOf(error));
      }
    },

    inspectAgent: (id) => set({ inspectAgentId: id }),

    refreshChats: async () => {
      try {
        const chats = await api.listChats();
        set({ chats: sortMetas(chats) });
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
