import { useEffect, useRef } from "react";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";

import { isTauri } from "./api";

/**
 * The Android back gesture, routed to whatever is on top.
 *
 * Tauri's app plugin hands every back press to JavaScript while a
 * `back-button` listener is registered; with none it falls back to the
 * WebView's own history, which this single-page shell does not have, so the
 * app closes. Registering here is therefore a promise to handle every press:
 * the top screen, sheet or dialog takes it, and the home screen is the only
 * place left to leave the app.
 *
 * Layers, not mount order, decide who is on top: a sheet opened over a
 * conversation is a later mount, but a dialog opened inside that sheet must
 * still win even if a parent re-renders first.
 */

export const BACK_LAYER = {
  screen: 10,
  sheet: 20,
  dialog: 30,
} as const;

type Entry = {
  layer: number;
  run: () => void;
};

const entries: Entry[] = [];
let listening = false;

function listen() {
  if (listening || !isTauri()) return;
  listening = true;
  void onBackButtonPress(({ canGoBack }) => {
    const top = entries.reduce<Entry | null>(
      (best, entry) => (!best || entry.layer >= best.layer ? entry : best),
      null,
    );
    if (top) {
      top.run();
      return;
    }
    // A page navigation inside the WebView still takes precedence; this shell
    // normally has none, but a link that stayed in the app should go back.
    if (canGoBack) {
      window.history.back();
      return;
    }
    // Nothing on screen wants the press and the home screen is the root: this
    // is the one back that leaves, exactly like the native gesture would.
    void exit(0).catch(() => undefined);
  }).catch(() => {
    // A desktop or a build without the app plugin keeps its native behavior.
    listening = false;
  });
}

/**
 * Claim the back gesture while `enabled`. The most recently registered handler
 * at the highest layer runs first; equal layers fall back to registration
 * order, so a sheet's own dialog wins over the sheet.
 */
export function useBackHandler(
  layer: number,
  enabled: boolean,
  run: () => void,
) {
  const latest = useRef(run);
  useEffect(() => {
    latest.current = run;
  }, [run]);

  useEffect(() => {
    if (!enabled) return;
    listen();
    const entry: Entry = { layer, run: () => latest.current() };
    entries.push(entry);
    return () => {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
    };
  }, [enabled, layer]);
}
