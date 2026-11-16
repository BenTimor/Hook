import { create } from "zustand";
import { toast } from "sonner";

import { api, isTauri, onUpdateEvent } from "../lib/bridge";
import type { UpdateInfo } from "../lib/types";

/** Re-check while Hook stays open all day. */
export const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000;

interface UpdateStore {
  info: UpdateInfo | null;
  checking: boolean;
  installing: boolean;
  phase: "downloading" | "installing" | null;
  progress: { received: number; total: number | null } | null;
  /** "Later" hides the banner for this version, not for a required update. */
  dismissedVersion: string | null;
  error: string | null;
  check: (options?: { silent?: boolean }) => Promise<UpdateInfo | null>;
  install: () => Promise<void>;
  dismiss: () => void;
}

function textOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Could not check for updates.";
}

let inFlight: Promise<UpdateInfo | null> | null = null;
let unsubscribe: (() => void) | null = null;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  info: null,
  checking: false,
  installing: false,
  phase: null,
  progress: null,
  dismissedVersion: null,
  error: null,

  check: async (options = {}) => {
    if (inFlight) return inFlight;
    set({ checking: true });
    inFlight = (async () => {
      try {
        const info = await api.checkUpdate();
        set({ info, checking: false, error: null });
        return info;
      } catch (error) {
        const message = textOf(error);
        // A background check is allowed to fail quietly: offline launches and
        // an unreachable update service are not errors the user must act on.
        if (options.silent) {
          set({ checking: false });
        } else {
          set({ checking: false, error: message });
          toast.error(message);
        }
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  install: async () => {
    if (get().installing) return;
    set({ installing: true, phase: "downloading", progress: null, error: null });

    if (!isTauri()) {
      // Design preview: walk the bar, then explain that this is the browser.
      const total = get().info?.size ?? 29_400_000;
      for (const fraction of [0.08, 0.19, 0.34, 0.52, 0.71, 0.88, 0.98]) {
        set({ progress: { received: Math.round(total * fraction), total } });
        await new Promise((resolve) => setTimeout(resolve, 320));
      }
      set({ installing: false, phase: null, progress: null });
      toast("The real installer runs in the desktop app.");
      return;
    }

    unsubscribe?.();
    unsubscribe = onUpdateEvent((event) => {
      set({
        phase: event.phase,
        progress: { received: event.received, total: event.total },
      });
    });

    try {
      await api.installUpdate();
      // Hook exits here; the installer replaces it and starts it again.
    } catch (error) {
      const message = textOf(error);
      unsubscribe?.();
      unsubscribe = null;
      set({ installing: false, phase: null, progress: null, error: message });
      toast.error(message);
    }
  },

  dismiss: () => set({ dismissedVersion: get().info?.latest ?? null }),
}));
