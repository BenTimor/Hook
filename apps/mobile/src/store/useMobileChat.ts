import { create } from "zustand";
import type { DraftImage } from "@hook/chat";

import { mobile } from "../lib/api";
import type {
  AuthView,
  ChatMeta,
  Message,
  PreviewView,
  SettingsView,
  StreamEvent,
} from "../lib/types";

/**
 * The phone's whole state.
 *
 * Deliberately not the desktop store: that one also owns coding agents, the
 * task board, preview pages and the import flow. A phone has none of those, and
 * copying them here would be the first step towards a second implementation of
 * a product this repo already has. What both do share is the event shape
 * (`StreamEvent`), which is why `Thread` and `Composer` need no adapter.
 */

interface Stream {
  text: string;
  reasoning: string;
}

interface MobileState {
  ready: boolean;
  error: string | null;
  auth: AuthView | null;
  chats: ChatMeta[];
  /** The open conversation, or null on the list or in a new chat. */
  activeId: string | null;
  /** The conversation screen is open with nothing sent yet. */
  composing: boolean;
  messages: Message[];
  streams: Record<string, Stream>;
  activity: Record<string, string[]>;
  draft: string;
  /** Pictures staged in the composer, already downscaled by the surface. */
  draftImages: DraftImage[];
  /**
   * A send is in flight and the chat id is not known yet. `send_message`
   * creates the chat, so the first `started` event for a chat we do not have
   * open is ours to adopt — but only while this is true, or a turn waking in
   * another chat would yank the screen away from what the person is typing.
   */
  sending: boolean;
  settings: SettingsView | null;
  preview: PreviewView | null;
  previewOpen: boolean;

  init: () => Promise<void>;
  open: (chatId: string) => Promise<void>;
  newChat: () => void;
  back: () => void;
  setDraft: (value: string) => void;
  addDraftImages: (images: DraftImage[]) => void;
  removeDraftImage: (id: string) => void;
  renameChat: (id: string, title: string) => Promise<void>;
  togglePinned: (id: string, pinned: boolean) => Promise<void>;
  removeChat: (id: string) => Promise<void>;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  setPreviewOpen: (open: boolean) => void;
  setAdvanced: (enabled: boolean) => Promise<void>;
  signIn: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  handleEvent: (chatId: string, event: StreamEvent) => void;
  handlePreview: (event: PreviewView | { active: false }) => void;
}

export const useMobileChat = create<MobileState>((set, get) => ({
  ready: false,
  error: null,
  auth: null,
  chats: [],
  activeId: null,
  composing: false,
  messages: [],
  streams: {},
  activity: {},
  draft: "",
  draftImages: [],
  sending: false,
  settings: null,
  preview: null,
  previewOpen: false,

  async init() {
    try {
      const [auth, chats, settings, preview] = await Promise.all([
        mobile.authStatus(),
        mobile.listChats(),
        mobile.getSettings(),
        mobile.previewState(),
      ]);
      set({
        ready: true,
        auth,
        chats,
        settings,
        preview: preview && preview.active ? preview : null,
      });
    } catch (error) {
      set({ ready: true, error: message(error) });
    }
  },

  async open(chatId) {
    set({ activeId: chatId, composing: false, error: null });
    try {
      const chat = await mobile.getChat(chatId);
      // A turn may have started while the list was open; the reload wins only
      // when nothing is streaming into this chat.
      if (get().activeId !== chatId) return;
      if (!get().streams[chatId]) set({ messages: chat.messages });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  newChat() {
    set({ activeId: null, composing: true, messages: [], draft: "", error: null });
  },

  back() {
    set({ activeId: null, composing: false, messages: [], draft: "" });
  },

  setDraft(value) {
    set({ draft: value });
  },

  addDraftImages(images) {
    // Six is enough for a phone: more than that and the strip is the message.
    set((state) => ({
      draftImages: [...state.draftImages, ...images].slice(0, 6),
    }));
  },

  removeDraftImage(id) {
    set((state) => ({
      draftImages: state.draftImages.filter((image) => image.id !== id),
    }));
  },

  // Ordering (pinned first, then newest) is the backend's: it owns the list.
  async renameChat(id, title) {
    const clean = title.trim();
    if (!clean) return;
    try {
      await mobile.renameChat(id, clean);
      set({ chats: await mobile.listChats() });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async togglePinned(id, pinned) {
    try {
      await mobile.setPinned(id, pinned);
      set({ chats: await mobile.listChats() });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async removeChat(id) {
    try {
      await mobile.deleteChat(id);
      const open = get().activeId === id;
      set({
        chats: await mobile.listChats(),
        ...(open ? { activeId: null, composing: false, messages: [] } : {}),
      });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async send() {
    const { draft, draftImages, activeId, messages } = get();
    const text = draft.trim();
    if (!text && draftImages.length === 0) return;
    set({
      draft: "",
      draftImages: [],
      error: null,
      // Only while the chat id is unknown: from an open chat the event already
      // knows which one it belongs to.
      sending: !activeId,
    });
    try {
      const chatId = await mobile.sendMessage(
        activeId,
        text,
        draftImages.map((image) => ({
          dataUrl: image.dataUrl,
          width: image.width,
          height: image.height,
        })),
      );
      // The `started` event may already have opened this chat (a new chat's
      // stream can beat the command's return value). Only fill the gap if not.
      if (get().activeId !== chatId) {
        set({
          activeId: chatId,
          composing: false,
          messages: [
            ...messages,
            ...(text
              ? [
                  {
                    id: "pending",
                    role: "user" as const,
                    content: text,
                    status: "complete" as const,
                  },
                ]
              : []),
          ],
        });
      }
      if (!get().chats.some((chat) => chat.id === chatId)) {
        const chats = await mobile.listChats();
        set({ chats });
      }
    } catch (error) {
      set({ draft: text, draftImages, error: message(error) });
    } finally {
      set({ sending: false });
    }
  },

  async stop() {
    const chatId = get().activeId;
    if (!chatId) return;
    await mobile.stopStream(chatId).catch(() => undefined);
  },

  setPreviewOpen(open) {
    set({ previewOpen: open });
  },

  async setAdvanced(enabled) {
    try {
      set({ settings: await mobile.setAdvancedMode(enabled) });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async signIn() {
    try {
      set({ auth: await mobile.authLogin() });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async signInWithGoogle() {
    try {
      set({ auth: await mobile.signInWithGoogle(), error: null });
    } catch (error) {
      // Closing the account sheet is a decision, not a failure.
      const text = message(error);
      if (/cancel/i.test(text)) return;
      set({ error: text });
    }
  },

  async cancelSignIn() {
    set({ auth: await mobile.authCancelLogin() });
  },

  async signOut() {
    set({
      auth: await mobile.authLogout(),
      chats: [],
      activeId: null,
      composing: false,
      messages: [],
      draftImages: [],
    });
  },

  handleEvent(chatId, event) {
    const state = get();
    const stream = state.streams[chatId] ?? { text: "", reasoning: "" };
    switch (event.kind) {
      case "started": {
        const chats = upsert(state.chats, event.meta);
        // This chat is on screen, or it is the one being created right now.
        const adopt =
          state.activeId === chatId || (state.sending && state.activeId === null);
        set({
          chats,
          streams: { ...state.streams, [chatId]: { text: "", reasoning: "" } },
          activity: { ...state.activity, [chatId]: [] },
          ...(adopt
            ? { activeId: chatId, composing: false, messages: event.messages }
            : {}),
        });
        return;
      }
      case "delta":
        set({
          streams: {
            ...state.streams,
            [chatId]: { ...stream, text: stream.text + event.text },
          },
        });
        return;
      case "reasoning":
        set({
          streams: {
            ...state.streams,
            [chatId]: { ...stream, reasoning: stream.reasoning + event.text },
          },
        });
        return;
      case "activity": {
        const labels = state.activity[chatId] ?? [];
        set({
          activity: {
            ...state.activity,
            [chatId]: event.label ? [...labels, event.label] : [],
          },
        });
        return;
      }
      case "done": {
        const streams = { ...state.streams };
        delete streams[chatId];
        const activity = { ...state.activity };
        delete activity[chatId];
        set({
          streams,
          activity,
          ...(state.activeId === chatId ? { messages: event.messages } : {}),
        });
        // A finished turn is when the title is generated, so the list's order
        // and the row's preview are stale until it is read again.
        void mobile
          .listChats()
          .then((chats) => set({ chats }))
          .catch(() => undefined);
        return;
      }
      case "error": {
        const streams = { ...state.streams };
        delete streams[chatId];
        set({ streams, error: event.message });
        return;
      }
    }
  },

  handlePreview(event) {
    if (!event.active) {
      set({ preview: null, previewOpen: false });
      return;
    }
    // The panel opens itself the first time a run shows something, and keeps
    // whatever the user did with it afterwards.
    const first = get().preview?.chatId !== event.chatId;
    set({ preview: event, previewOpen: get().previewOpen || (first && event.open) });
  },
}));

function upsert(chats: ChatMeta[], meta: ChatMeta): ChatMeta[] {
  const next = chats.some((chat) => chat.id === meta.id)
    ? chats.map((chat) => (chat.id === meta.id ? meta : chat))
    : [meta, ...chats];
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
