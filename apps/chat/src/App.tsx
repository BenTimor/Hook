import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { useWindowState } from "@hook/ui";

import { isTauri } from "./lib/bridge";
import { useChatStore } from "./store/useChatStore";
import { UPDATE_CHECK_INTERVAL, useUpdateStore } from "./store/useUpdateStore";
import { AgentBoard } from "./components/AgentBoard";
import { AgentInspector } from "./components/AgentInspector";
import { Composer } from "./components/Composer";
import { Hero } from "./components/Hero";
import { LoginScreen } from "./components/LoginScreen";
import { PaneHead } from "./components/PaneHead";
import { PreviewPanel } from "./components/PreviewPanel";
import { SettingsSheet } from "./components/SettingsSheet";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { Sidebar } from "./components/Sidebar";
import { Thread } from "./components/Thread";
import { WorkspaceView } from "./WorkspaceView";

export default function App() {
  const bootstrap = useChatStore((s) => s.bootstrap);
  const auth = useChatStore((s) => s.auth);
  const activeId = useChatStore((s) => s.activeId);
  const newChat = useChatStore((s) => s.newChat);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const requestSearch = useChatStore((s) => s.requestSearch);
  const stop = useChatStore((s) => s.stop);
  const streaming = useChatStore((s) =>
    s.activeId ? Boolean(s.streams[s.activeId] || s.activity[s.activeId]) : false,
  );

  const maximized = useWindowState();
  const signedIn = Boolean(auth?.signedIn);
  // The two halves of one product. Workspace is the Workspace app's own tree;
  // this is only which one the window is showing.
  const [view, setView] = useState<"chat" | "workspace">("chat");
  const checkUpdate = useUpdateStore((s) => s.check);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // The release index is public, so this also runs before signing in: a build
  // below the supported floor must be able to say so on the login screen.
  useEffect(() => {
    void checkUpdate({ silent: true });
    const timer = window.setInterval(
      () => void checkUpdate({ silent: true }),
      UPDATE_CHECK_INTERVAL,
    );
    return () => window.clearInterval(timer);
  }, [checkUpdate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The chat shortcuts must not fire behind Workspace: Cmd+B belongs to the
      // editor there, and Cmd+N and Cmd+K would act on a hidden list.
      if (!signedIn || view === "workspace") return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) {
        if (
          event.key === "Escape" &&
          streaming &&
          !useChatStore.getState().inspectAgentId
        ) {
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
  }, [newChat, requestSearch, streaming, stop, toggleSidebar, signedIn, view]);

  useEffect(() => {
    // These guards are the chat surface's: they keep a drop from navigating the
    // webview and a right-click from opening a browser menu. Workspace has its
    // own menus and its own drop targets, so it is left alone.
    if (!isTauri() || view !== "chat") return;
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
  }, [view]);

  // Signing out from either half puts the window back to Chat, so signing in
  // again does not land in a workspace that was open before.
  useEffect(() => {
    if (!signedIn) setView("chat");
  }, [signedIn]);

  if (!signedIn) {
    return (
      <>
        <LoginScreen maximized={maximized} />
        <UpdatePrompt showBanner={false} />
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
      </>
    );
  }

  if (view === "workspace" && auth) {
    return (
      <WorkspaceView
        auth={auth}
        maximized={maximized}
        onChat={() => setView("chat")}
        onAuth={(next) => useChatStore.setState({ auth: next })}
      />
    );
  }

  return (
    <div className="shell" data-maximized={maximized}>
      <Sidebar onWorkspace={() => setView("workspace")} />
      <main className="pane">
        <PaneHead />
        <UpdatePrompt />
        <div className="pane-body">
          {activeId ? (
            <>
              <Thread />
              <div className="composer-dock">
                <AgentBoard />
                <Composer />
              </div>
            </>
          ) : (
            <Hero />
          )}
        </div>
      </main>
      <PreviewPanel />
      <AgentInspector />
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
