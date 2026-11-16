import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { mock } from "./mock";
import type {
  AgentsOverview,
  AppInfo,
  AuthView,
  Chat,
  ChatEvent,
  ChatMeta,
  PreviewEvent,
  PreviewView,
  ReportRequest,
  SearchHit,
  SettingsView,
  StreamEvent,
  SyncEvent,
  SyncView,
  UpdateEvent,
  UpdateInfo,
} from "./types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type ChatListener = (chatId: string, event: StreamEvent) => void;
type AgentsListener = (overview: AgentsOverview) => void;
type PreviewListener = (preview: PreviewEvent) => void;
type AuthListener = (view: AuthView) => void;
type UpdateListener = (event: UpdateEvent) => void;
type SyncListener = (event: SyncEvent) => void;

const chatListeners = new Set<ChatListener>();
const agentsListeners = new Set<AgentsListener>();
const previewListeners = new Set<PreviewListener>();
const authListeners = new Set<AuthListener>();
const updateListeners = new Set<UpdateListener>();
const syncListeners = new Set<SyncListener>();

function dispatch(chatId: string, event: StreamEvent) {
  for (const listener of chatListeners) listener(chatId, event);
}

/**
 * Every turn — user-sent or woken by a coding agent — arrives on the same
 * app-wide event, so the UI never has to hold a per-call channel.
 */
export function onChatEvent(listener: ChatListener): () => void {
  if (!isTauri()) {
    chatListeners.add(listener);
    return () => chatListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<ChatEvent>("hook://chat", (event) =>
    listener(event.payload.chatId, event.payload.event),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

export function onAgentsEvent(listener: AgentsListener): () => void {
  if (!isTauri()) {
    agentsListeners.add(listener);
    return () => agentsListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<AgentsOverview>("hook://agents", (event) =>
    listener(event.payload),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * The preview panel is a sidecar of the app, not of one chat: the backend
 * keeps at most one page open and announces the page being shown, every
 * refresh, the run settling (no more auto-refresh) and when the panel closes.
 */
export function onPreviewEvent(listener: PreviewListener): () => void {
  if (!isTauri()) {
    previewListeners.add(listener);
    return () => previewListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<PreviewEvent>("hook://preview", (event) =>
    listener(event.payload),
  ).then((unlisten) => {
    if (cancelled) unlisten();
    else off = unlisten;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * Sign-in state changes: pending while the browser approval is open, then
 * signed_in, cancelled or signed_out after a revocation.
 */
export function onAuthEvent(listener: AuthListener): () => void {
  if (!isTauri()) {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<AuthView>("hook://auth", (event) => listener(event.payload)).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    },
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/**
 * The background sync applied something from the account. `chats` means the
 * list or a conversation changed; `projects` means a project was created here.
 */
export function onSyncEvent(listener: SyncListener): () => void {
  if (!isTauri()) {
    syncListeners.add(listener);
    return () => syncListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<SyncEvent>("hook://sync", (event) => listener(event.payload)).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    },
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** Download progress for an in-app update. The app exits when it is installed. */
export function onUpdateEvent(listener: UpdateListener): () => void {
  if (!isTauri()) {
    updateListeners.add(listener);
    return () => updateListeners.delete(listener);
  }
  let off: (() => void) | null = null;
  let cancelled = false;
  void listen<UpdateEvent>("hook://update", (event) => listener(event.payload)).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    },
  );
  return () => {
    cancelled = true;
    off?.();
  };
}

/** Browser preview: the in-memory backend replays turns through the same bus. */
async function streamMock(
  command: string,
  args: Record<string, unknown>,
): Promise<string> {
  let chatId = typeof args.chatId === "string" ? args.chatId : "";
  return mock.stream(command, args, (event) => {
    if ("meta" in event) chatId = event.meta.id;
    dispatch(chatId, event);
  });
}

export const api = {
  appInfo: (): Promise<AppInfo> =>
    isTauri() ? invoke<AppInfo>("app_info") : mock.appInfo(),

  authStatus: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_status") : mock.authStatus(),

  authLogin: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_login") : mock.authLogin(),

  authCancelLogin: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_cancel_login") : mock.authCancelLogin(),

  authRefresh: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_refresh") : mock.authRefresh(),

  authLogout: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_logout") : mock.authLogout(),

  listChats: (): Promise<ChatMeta[]> =>
    isTauri() ? invoke<ChatMeta[]>("list_chats") : mock.listChats(),

  getChat: (chatId: string): Promise<Chat> =>
    isTauri() ? invoke<Chat>("get_chat", { chatId }) : mock.getChat(chatId),

  renameChat: (chatId: string, title: string): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("rename_chat", { chatId, title })
      : mock.renameChat(chatId, title),

  setPinned: (chatId: string, pinned: boolean): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("set_pinned", { chatId, pinned })
      : mock.setPinned(chatId, pinned),

  deleteChat: (chatId: string): Promise<void> =>
    isTauri() ? invoke<void>("delete_chat", { chatId }) : mock.deleteChat(chatId),

  restoreChat: (chatId: string): Promise<ChatMeta> =>
    isTauri()
      ? invoke<ChatMeta>("restore_chat", { chatId })
      : mock.restoreChat(chatId),

  searchChats: (query: string): Promise<SearchHit[]> =>
    isTauri()
      ? invoke<SearchHit[]>("search_chats", { query })
      : mock.searchChats(query),

  sendMessage: (
    chatId: string | null,
    text: string,
    images: { dataUrl: string; width: number; height: number }[] = [],
  ): Promise<string> =>
    isTauri()
      ? invoke<string>("send_message", { chatId, text, images })
      : streamMock("send_message", { chatId, text, images }),

  readImage: (chatId: string, attachmentId: string): Promise<string> =>
    isTauri()
      ? invoke<string>("read_image", { chatId, attachmentId })
      : mock.readImage(chatId, attachmentId),

  openImage: (chatId: string, attachmentId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("open_image", { chatId, attachmentId })
      : Promise.resolve(),

  saveImageAs: (
    chatId: string,
    attachmentId: string,
    suggestedName: string,
  ): Promise<boolean> =>
    isTauri()
      ? invoke<boolean>("save_image_as", { chatId, attachmentId, suggestedName })
      : Promise.resolve(false),

  regenerate: (chatId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("regenerate", { chatId })
      : streamMock("regenerate", { chatId }).then(() => undefined),

  editMessage: (chatId: string, messageId: string, text: string): Promise<void> =>
    isTauri()
      ? invoke<void>("edit_message", { chatId, messageId, text })
      : streamMock("edit_message", { chatId, messageId, text }).then(() => undefined),

  stopStream: (chatId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("stop_stream", { chatId })
      : mock.stopStream(chatId),

  getSettings: (): Promise<SettingsView> =>
    isTauri() ? invoke<SettingsView>("get_settings") : mock.getSettings(),

  setProjectsDir: (path: string): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("set_projects_dir", { path })
      : mock.setProjectsDir(path),

  openPath: (path: string): Promise<void> =>
    isTauri() ? invoke<void>("open_path", { path }) : Promise.resolve(),

  agentsOverview: (): Promise<AgentsOverview> =>
    isTauri() ? invoke<AgentsOverview>("agents_overview") : mock.agentsOverview(),

  checkUpdate: (): Promise<UpdateInfo> =>
    isTauri() ? invoke<UpdateInfo>("check_update") : mock.checkUpdate(),

  installUpdate: (): Promise<void> =>
    isTauri() ? invoke<void>("install_update") : mock.installUpdate(),

  openStoreUpdate: (): Promise<void> =>
    isTauri() ? invoke<void>("open_store_update") : mock.openStoreUpdate(),

  reportMessage: (payload: ReportRequest): Promise<void> =>
    isTauri()
      ? invoke<void>("report_message", { payload })
      : mock.reportMessage(),

  previewState: (): Promise<PreviewView | null> =>
    isTauri()
      ? invoke<PreviewView | null>("preview_state")
      : mock.previewState(),

  syncStatus: (): Promise<SyncView> =>
    isTauri() ? invoke<SyncView>("sync_status") : mock.syncStatus(),

  syncNow: (): Promise<void> =>
    isTauri() ? invoke<void>("sync_now") : mock.syncNow(),


  stopChatAgents: (chatId: string): Promise<AgentsOverview> =>
    isTauri()
      ? invoke<AgentsOverview>("stop_chat_agents", { chatId })
      : mock.stopChatAgents(),

  async pickFolder(): Promise<string | null> {
    if (!isTauri()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose a folder for your projects",
    });
    return typeof picked === "string" ? picked : null;
  },
};

export const win = {
  minimize: () => isTauri() && getCurrentWindow().minimize(),
  toggleMaximize: () => isTauri() && getCurrentWindow().toggleMaximize(),
  close: () => isTauri() && getCurrentWindow().close(),
  isMaximized: async (): Promise<boolean> =>
    isTauri() ? getCurrentWindow().isMaximized() : false,
  onResized: (callback: () => void) => {
    if (!isTauri()) return () => {};
    const pending = getCurrentWindow().onResized(callback);
    return () => {
      pending.then((off) => off()).catch(() => {});
    };
  },
};

export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    /* ignore malformed or blocked links */
  }
}
