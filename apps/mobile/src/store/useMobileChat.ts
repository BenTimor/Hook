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
  SyncEvent,
  SyncView,
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
  /** The open conversation, or null on the home screen. */
  activeId: string | null;
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
  /** Whether conversations may leave this phone, and why not when they may not. */
  sync: SyncView | null;
  preview: PreviewView | null;
  previewOpen: boolean;

  init: () => Promise<void>;
  refreshChats: () => Promise<void>;
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
  /** The account-wide switch; the desktop flips the same one. */
  setCloudSync: (enabled: boolean) => Promise<void>;
  /** This phone's own endpoint and key. Throws with a readable reason. */
  saveCustomProvider: (baseUrl: string, apiKey: string, model: string) => Promise<void>;
  clearCustomProvider: () => Promise<void>;
  refreshSync: () => Promise<void>;
  /** Re-read the account view (plan, cloud switch, free window). */
  refreshAuth: () => Promise<void>;
  signIn: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  handleAuth: (view: AuthView) => void;
  handleSync: (event: SyncEvent) => void;
  handleEvent: (chatId: string, event: StreamEvent) => void;
  handlePreview: (event: PreviewView | { active: false }) => void;
}

/** Orders overlapping list reads; higher is newer. */
let chatRead = 0;

export const useMobileChat = create<MobileState>((set, get) => ({
  ready: false,
  error: null,
  auth: null,
  chats: [],
  activeId: null,
  messages: [],
  streams: {},
  activity: {},
  draft: "",
  draftImages: [],
  sending: false,
  settings: null,
  sync: null,
  preview: null,
  previewOpen: false,

  async init() {
    try {
      const [auth, settings, preview, sync] = await Promise.all([
        mobile.authStatus(),
        mobile.getSettings(),
        mobile.previewState(),
        mobile.syncStatus(),
      ]);
      set({
        auth,
        settings,
        sync,
        preview: preview && preview.active ? preview : null,
      });
      // Read the list after the auth view exists, so a sync event arriving at
      // the same time cannot be overwritten by a read that started before it.
      if (auth.signedIn) {
        mobile.syncNow();
        await get().refreshChats();
      }
      set({ ready: true });
    } catch (error) {
      set({ ready: true, error: message(error) });
    }
  },

  /**
   * Re-read the list, and the open chat when it is idle. The background sync
   * has already merged the changes; this is only what the screen does about it.
   * A chat that is streaming here is never replaced by the account's copy.
   *
   * Reads are numbered: a list read that started before a sync applied must not
   * put its older answer over the one the sync event has just fetched.
   */
  async refreshChats() {
    const read = ++chatRead;
    let chats: ChatMeta[];
    try {
      chats = await mobile.listChats();
    } catch {
      return;
    }
    // `null` is the startup window before `init` has read the auth view; the
    // account's chats are still the right thing to read. A signed-out view,
    // on the other hand, must not be repopulated by a read that was in flight.
    const auth = get().auth;
    if (read !== chatRead || (auth && !auth.signedIn)) return;
    set({ chats });

    const activeId = get().activeId;
    if (!activeId || get().streams[activeId] || get().activity[activeId]) return;
    try {
      const chat = await mobile.getChat(activeId);
      if (read !== chatRead) return;
      if (
        get().activeId === activeId &&
        !get().streams[activeId] &&
        !get().activity[activeId]
      ) {
        set({ messages: chat.messages });
      }
    } catch {
      // It was deleted on another computer.
      if (read === chatRead && get().activeId === activeId) {
        set({ activeId: null, messages: [] });
      }
    }
  },

  async open(chatId) {
    set({ activeId: chatId, error: null });
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
    set({ activeId: null, messages: [], draft: "", error: null });
  },

  back() {
    set({ activeId: null, messages: [], draft: "" });
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
        ...(open ? { activeId: null, messages: [] } : {}),
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

  async setCloudSync(enabled) {
    try {
      set({ settings: await mobile.setCloudSync(enabled) });
      await get().refreshSync();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async saveCustomProvider(baseUrl, apiKey, model) {
    // The sheet shows the reason next to the field, so this one throws.
    set({ settings: await mobile.setCustomProvider(baseUrl, apiKey, model) });
  },

  async clearCustomProvider() {
    set({ settings: await mobile.clearCustomProvider() });
  },

  async refreshSync() {
    try {
      set({ sync: await mobile.syncStatus() });
    } catch {
      // A stale line is not an error worth a banner.
    }
  },

  async refreshAuth() {
    try {
      set({ auth: await mobile.authRefresh() });
    } catch {
      // The cached view is still the last one the server confirmed.
    }
  },

  async signIn() {
    try {
      get().handleAuth(await mobile.authLogin());
    } catch (error) {
      set({ error: message(error) });
    }
  },

  async signInWithGoogle() {
    try {
      get().handleAuth(await mobile.signInWithGoogle());
      set({ error: null });
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
    try {
      // The event is the source of truth; the returned view is the same one.
      get().handleAuth(await mobile.authLogout());
    } catch (error) {
      set({ error: message(error) });
    }
  },

  /**
   * A sign-in, a sign-out, or a revoked account.
   *
   * The first signed-in view is the moment the account's conversations become
   * readable: `init` ran before there was a token, so the list it fetched was
   * empty. Reload it here (and wake sync) rather than making the user close and
   * reopen the app to see what the desktop already has.
   */
  handleAuth(view) {
    const wasSignedIn = Boolean(get().auth?.signedIn);
    set({ auth: view });
    if (!view.signedIn) {
      if (wasSignedIn) {
        set({
          chats: [],
          activeId: null,
          messages: [],
          draftImages: [],
          sync: null,
        });
      }
      return;
    }
    if (wasSignedIn) {
      // A plan change or a switch flipped on another product arrives here.
      void get().refreshSync();
      void mobile
        .getSettings()
        .then((settings) => set({ settings }))
        .catch(() => undefined);
      return;
    }
    void mobile
      .getSettings()
      .then((settings) => {
        if (!get().auth?.signedIn) return;
        set({ settings });
        void get().refreshSync();
        mobile.syncNow();
        return get().refreshChats();
      })
      .catch((error) => set({ error: message(error) }));
  },

  /** The background sync applied something from the account. */
  handleSync(event) {
    // No auth gate: a cycle only runs while a token exists, and at startup the
    // event can arrive before `init` has finished setting the auth view. The
    // list it refreshes is the account's; a signed-out screen ignores it.
    void get().refreshSync();
    if (!event.chats) return;
    void get().refreshChats();
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
            ? { activeId: chatId, messages: event.messages }
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
        const activity = { ...state.activity };
        // `null` is the turn saying it has stopped, not an empty batch of
        // labels: an empty array means "the turn started and has no tool yet",
        // which is exactly the "Thinking…" line that must now go away.
        if (event.label === null) {
          delete activity[chatId];
        } else {
          const labels = state.activity[chatId] ?? [];
          activity[chatId] = [...labels, event.label];
        }
        set({ activity });
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
        const activity = { ...state.activity };
        delete activity[chatId];
        set({ streams, activity, error: event.message });
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
