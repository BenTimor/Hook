/**
 * Tauri, for the one place that has none.
 *
 * `packages/ui` and `packages/chat` load `@tauri-apps/api` lazily, behind
 * `isTauri()`, so this module is never *called* in a Chromium WebUI. It exists so
 * the bundle has something to resolve those dynamic imports to: without it, Vite
 * would emit `@tauri-apps/api` as a chunk file next to `panel.mjs`, and the pak
 * would grow a second copy of a host that is not there.
 *
 * If a browser build ever calls into this, the call is a bug: the guard that
 * should have stopped it is `isTauri()`.
 */

export async function invoke(command: string): Promise<never> {
  throw new Error(`no Tauri in the browser (${command})`);
}

export function getCurrentWindow(): never {
  throw new Error("no Tauri window in the browser");
}
