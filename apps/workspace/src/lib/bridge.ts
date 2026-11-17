import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@hook/ui";

/**
 * What the window needs to draw the login screen or the account row.
 * Mirrors `AuthView` in hook-core.
 */
export interface AuthView {
  signedIn: boolean;
  state: "signed_out" | "pending" | "signed_in";
  email?: string | null;
  name?: string | null;
  userCode?: string | null;
  verificationUrl?: string | null;
  message?: string | null;
}

export interface AppInfo {
  version: string;
  product?: "chat" | "workspace";
}

/**
 * Every backend call Workspace makes. The backend is `hook-core`, shared with
 * the chat app, so the account and the synced chats are the same objects — this
 * file only wraps the commands this product uses.
 */
export const api = {
  appInfo: (): Promise<AppInfo> =>
    isTauri()
      ? invoke<AppInfo>("app_info")
      : Promise.resolve({ version: "0.1.0", product: "workspace" }),

  authStatus: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_status")
      : // A browser build shows the signed-in workspace so the UI can be
        // developed without the desktop shell.
        Promise.resolve({
          signedIn: true,
          state: "signed_in",
          email: "you@example.com",
          name: "You",
        }),

  authLogin: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_login")
      : Promise.resolve({ signedIn: true, state: "signed_in", email: "you@example.com" }),

  authCancelLogin: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_cancel_login")
      : Promise.resolve({ signedIn: false, state: "signed_out" }),

  authLogout: (): Promise<AuthView> =>
    isTauri()
      ? invoke<AuthView>("auth_logout")
      : Promise.resolve({ signedIn: false, state: "signed_out" }),
};

/** Account changes also arrive as events: sign-in completes in the background. */
export function onAuthEvent(callback: (view: AuthView) => void): () => void {
  if (!isTauri()) return () => {};
  const pending = listen<AuthView>("hook://auth", (event) => callback(event.payload));
  return () => {
    void pending.then((off) => off()).catch(() => {});
  };
}

/** Open an http(s) URL in the system browser. */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_url", { url });
}
