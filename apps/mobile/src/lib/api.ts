import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@hook/ui";

import { demo } from "./demo";
import type {
  AppInfo,
  AuthView,
  Chat,
  ChatMeta,
  PreviewEvent,
  SettingsView,
  StreamEvent,
  SyncView,
} from "./types";

/**
 * The phone's whole IPC surface.
 *
 * It is deliberately small: `hook-core` runs with `Capabilities::mobile()`, so
 * there is no agent, no folder picker and no installer here. Every call has a
 * browser fallback so `pnpm --dir apps/mobile dev` renders a working shell with
 * demo data — the same two-backend shape the desktop's `bridge.ts` uses.
 */

export const mobile = {
  appInfo: (): Promise<AppInfo> =>
    isTauri() ? invoke<AppInfo>("app_info") : demo.appInfo(),

  authStatus: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_status") : demo.authStatus(),

  authLogin: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_login") : demo.authLogin(),

  authCancelLogin: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_cancel_login") : demo.authCancelLogin(),

  authRefresh: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_refresh") : demo.authStatus(),

  authLogout: (): Promise<AuthView> =>
    isTauri() ? invoke<AuthView>("auth_logout") : demo.authLogout(),

  /**
   * Whether this build has a native account sheet. Android answers yes; a
   * desktop has none, which is why the desktop keeps the device flow.
   */
  googleAvailable: (): Promise<boolean> =>
    isTauri()
      ? invoke<{ google: boolean }>("plugin:google-signin|available")
          .then((value) => Boolean(value?.google))
          .catch(() => false)
      : Promise.resolve(false),

  /** The Google client id this server expects a native token to name. */
  googleClientId: (): Promise<string | null> =>
    isTauri() ? invoke<string | null>("auth_google_config") : Promise.resolve(null),

  /**
   * The phone's own account sheet, then the exchange that turns its ID token
   * into a session. The token never leaves this process except to the server
   * that issued the account.
   */
  signInWithGoogle: async (): Promise<AuthView> => {
    const clientId = await mobile.googleClientId();
    if (!clientId) {
      throw new Error("This build has no Google sign-in configured.");
    }
    const { idToken } = await invoke<{ idToken: string }>(
      "plugin:google-signin|sign_in",
      { serverClientId: clientId },
    );
    return invoke<AuthView>("auth_google", { idToken });
  },

  listChats: (): Promise<ChatMeta[]> =>
    isTauri() ? invoke<ChatMeta[]>("list_chats") : demo.listChats(),

  getChat: (chatId: string): Promise<Chat> =>
    isTauri() ? invoke<Chat>("get_chat", { chatId }) : demo.getChat(chatId),

  renameChat: (chatId: string, title: string): Promise<void> =>
    isTauri() ? invoke<void>("rename_chat", { chatId, title }) : demo.renameChat(),

  setPinned: (chatId: string, pinned: boolean): Promise<void> =>
    isTauri() ? invoke<void>("set_pinned", { chatId, pinned }) : demo.setPinned(),

  deleteChat: (chatId: string): Promise<void> =>
    isTauri() ? invoke<void>("delete_chat", { chatId }) : demo.deleteChat(),

  sendMessage: (
    chatId: string | null,
    text: string,
    images: { dataUrl: string; width: number; height: number }[] = [],
  ): Promise<string> =>
    isTauri()
      ? invoke<string>("send_message", { chatId, text, images })
      : demo.sendMessage(chatId, text),

  stopStream: (chatId: string): Promise<void> =>
    isTauri() ? invoke<void>("stop_stream", { chatId }) : demo.stopStream(),

  regenerate: (chatId: string): Promise<void> =>
    isTauri() ? invoke<void>("regenerate", { chatId }) : demo.noop(),

  editMessage: (chatId: string, messageId: string, text: string): Promise<void> =>
    isTauri()
      ? invoke<void>("edit_message", { chatId, messageId, text })
      : demo.noop(),

  getSettings: (): Promise<SettingsView> =>
    isTauri() ? invoke<SettingsView>("get_settings") : demo.getSettings(),

  setAdvancedMode: (enabled: boolean): Promise<SettingsView> =>
    isTauri()
      ? invoke<SettingsView>("set_advanced_mode", { enabled })
      : demo.setAdvancedMode(enabled),

  syncStatus: (): Promise<SyncView> =>
    isTauri() ? invoke<SyncView>("sync_status") : demo.syncStatus(),

  syncNow: (): Promise<void> =>
    isTauri() ? invoke<void>("sync_now") : demo.noop(),

  previewState: (): Promise<PreviewEvent | null> =>
    isTauri() ? invoke<PreviewEvent | null>("preview_state") : demo.previewState(),

  reportMessage: (payload: Record<string, unknown>): Promise<void> =>
    isTauri() ? invoke<void>("report_message", { payload }) : demo.noop(),

  reportContent: (payload: Record<string, unknown>): Promise<void> =>
    isTauri() ? invoke<void>("report_content", { payload }) : demo.noop(),

  openUrl: (url: string): Promise<void> =>
    isTauri() ? invoke<void>("open_url", { url }) : demo.openUrl(url),

  readImage: (chatId: string, file: string): Promise<string> =>
    isTauri()
      ? invoke<string>("read_image", { chatId, file })
      : Promise.resolve(""),

  /** A finished turn and a coding-agent note both arrive here. */
  onChatEvent: (listener: (chatId: string, event: StreamEvent) => void): (() => void) =>
    isTauri()
      ? subscribe("hook://chat", (payload: { chatId: string; event: StreamEvent }) =>
          listener(payload.chatId, payload.event),
        )
      : demo.onChat(listener),

  onPreview: (listener: (event: PreviewEvent) => void): (() => void) =>
    isTauri() ? subscribe("hook://preview", listener) : demo.onPreview(listener),

  onAuth: (listener: (event: AuthView) => void): (() => void) =>
    subscribe("hook://auth", listener),

  onSync: (listener: (event: { at: number }) => void): (() => void) =>
    subscribe("hook://sync", listener),
};

function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  const pending = listen<T>(event, (message) => listener(message.payload));
  return () => {
    void pending.then((off) => off()).catch(() => {});
  };
}

/** Re-exported so a component never imports Tauri directly. */
export { isTauri };
