import { useEffect, useState } from "react";

/**
 * Tauri's own marker. In a plain browser (`pnpm dev`) every window call is a
 * no-op and the frameless chrome is just styled markup, so the UI can be built
 * without launching the app.
 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The window API, loaded only where there is a window to load it from.
 *
 * A static `import {getCurrentWindow} from "@tauri-apps/api/window"` at module
 * scope makes this package *depend* on Tauri being resolvable even where it never
 * runs — a Chromium WebUI (`browser/ui`) has no Tauri and should not have to
 * pretend. The import is therefore lazy and cached, and `win` keeps the same
 * shape the three products already call.
 */
type TauriWindow = typeof import("@tauri-apps/api/window");
let windowApi: TauriWindow | null = null;

async function currentWindow(): Promise<ReturnType<
  TauriWindow["getCurrentWindow"]
> | null> {
  if (!isTauri()) return null;
  if (!windowApi) windowApi = await import("@tauri-apps/api/window");
  return windowApi.getCurrentWindow();
}

export const win = {
  minimize: () => {
    void currentWindow().then((handle) => handle?.minimize());
  },
  toggleMaximize: () => {
    void currentWindow().then((handle) => handle?.toggleMaximize());
  },
  close: () => {
    void currentWindow().then((handle) => handle?.close());
  },
  isMaximized: async (): Promise<boolean> => {
    const handle = await currentWindow();
    return handle ? handle.isMaximized() : false;
  },
  onResized: (callback: () => void) => {
    let off: (() => void) | null = null;
    void currentWindow().then((handle) => {
      if (!handle) return;
      void handle.onResized(callback).then((stop) => {
        off = stop;
      });
    });
    return () => {
      off?.();
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
