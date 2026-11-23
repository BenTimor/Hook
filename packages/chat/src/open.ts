const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Open a link outside the app.
 *
 * Every Hook window is a webview; navigating it away from the app would lose the
 * window, so http(s) links go to the system browser instead of the frame.
 *
 * Tauri is imported lazily: this package is embedded by the Chromium WebUI too
 * (`browser/ui`), where there is no Tauri to resolve and `window.open` is the
 * right answer. A module-scope `import` would make every host carry it.
 */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_url", { url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
