import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { mock } from "./mock";
import type {
  AgentsOverview,
  AppInfo,
  Chat,
  ChatEvent,
  ChatMeta,
  SearchHit,
  SettingsView,
  StreamEvent,
} from "./types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type ChatListener = (chatId: string, event: StreamEvent) => void;
type AgentsListener = (overview: AgentsOverview) => void;

const chatListeners = new Set<ChatListener>();
const agentsListeners = new Set<AgentsListener>();

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
