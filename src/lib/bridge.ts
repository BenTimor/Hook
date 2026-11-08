import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { mock } from "./mock";
import type { AppInfo, Chat, ChatMeta, SearchHit, StreamEvent } from "./types";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Handler = (event: StreamEvent) => void;

async function streamCommand(
  command: string,
  args: Record<string, unknown>,
  onEvent: Handler,
): Promise<void> {
  if (!isTauri()) {
    await mock.stream(command, args, onEvent);
    return;
  }
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  await invoke(command, { ...args, channel });
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

  sendMessage: (chatId: string | null, text: string, onEvent: Handler) =>
    streamCommand("send_message", { chatId, text }, onEvent),

  regenerate: (chatId: string, onEvent: Handler) =>
    streamCommand("regenerate", { chatId }, onEvent),

  editMessage: (chatId: string, messageId: string, text: string, onEvent: Handler) =>
    streamCommand("edit_message", { chatId, messageId, text }, onEvent),

  stopStream: (chatId: string): Promise<void> =>
    isTauri()
      ? invoke<void>("stop_stream", { chatId })
      : mock.stopStream(chatId),
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
