import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Tauri's own marker. In a plain browser (`pnpm dev`) every window call is a
 * no-op and the frameless chrome is just styled markup, so the UI can be built
 * without launching the app.
 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

/**
 * Whether the window is maximized, kept current across resizes.
 *
 * The shell drops its 12px radius and the hairline when maximized; without this
 * a maximized window shows four rounded, clipped corners.
 */
export function useWindowState(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const value = await win.isMaximized();
      if (alive) setMaximized(value);
    };
    void sync();
    const off = win.onResized(() => void sync());
    return () => {
      alive = false;
      off();
    };
  }, []);

  return maximized;
}
