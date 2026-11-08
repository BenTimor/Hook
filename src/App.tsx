import { useEffect, useState } from "react";
import { Toaster } from "sonner";

import { isTauri, win } from "./lib/bridge";
import { useChatStore } from "./store/useChatStore";
import { Composer } from "./components/Composer";
import { Hero } from "./components/Hero";
import { PaneHead } from "./components/PaneHead";
import { SettingsSheet } from "./components/SettingsSheet";
import { Sidebar } from "./components/Sidebar";
import { Thread } from "./components/Thread";

export default function App() {
  const bootstrap = useChatStore((s) => s.bootstrap);
  const activeId = useChatStore((s) => s.activeId);
  const newChat = useChatStore((s) => s.newChat);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const requestSearch = useChatStore((s) => s.requestSearch);
  const stop = useChatStore((s) => s.stop);
  const streaming = useChatStore((s) =>
    s.activeId ? Boolean(s.streams[s.activeId]) : false,
  );

  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) {
        if (event.key === "Escape" && streaming) {
          event.preventDefault();
          void stop();
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        newChat();
      } else if (key === "k") {
        event.preventDefault();
        requestSearch();
      } else if (key === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newChat, requestSearch, streaming, stop, toggleSidebar]);

  useEffect(() => {
    if (!isTauri()) return;
    const block = (event: Event) => {
      const target = event.target as HTMLElement | null;
      // Keep the native menu (cut/copy/paste) inside text fields.
      if (target?.closest("input, textarea")) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("contextmenu", block);
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  return (
    <div className="shell" data-maximized={maximized}>
      <Sidebar />
      <main className="pane">
        <PaneHead />
        <div className="pane-body">
          {activeId ? (
            <>
              <Thread />
              <div className="composer-dock">
                <Composer />
              </div>
            </>
          ) : (
            <Hero />
          )}
        </div>
      </main>
      <SettingsSheet />
      <Toaster
        theme="light"
        position="bottom-center"
        offset={104}
        gap={8}
        toastOptions={{
          unstyled: true,
          classNames: { toast: "toast", actionButton: "toast-action" },
        }}
      />
    </div>
  );
}
