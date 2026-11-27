import { useEffect, useState } from "react";

import { mobile } from "./lib/api";
import { BACK_LAYER, useBackHandler } from "./lib/back";
import { useDrawer } from "./lib/useDrawer";
import { useMobileChat } from "./store/useMobileChat";
import { AppHeader } from "./components/AppHeader";
import { ChatDrawer } from "./components/ChatDrawer";
import { Conversation } from "./components/Conversation";
import { Home } from "./components/Home";
import { PreviewSheet } from "./components/PreviewSheet";
import { SettingsSheet } from "./components/SettingsSheet";
import { SignIn } from "./components/SignIn";
import { WorkspaceTasks } from "./components/WorkspaceTasks";

type View = "chats" | "workspace";

/**
 * Hook on a phone.
 *
 * One shell, one top bar and one drawer. The welcome screen and a conversation
 * are the same chat surface with or without an id; Workspace is the other
 * section in the drawer. The chat, composer, report dialog and Workspace
 * preview all come from `@hook/chat`; what lives here is the phone's chrome.
 */
export function App() {
  const ready = useMobileChat((s) => s.ready);
  const auth = useMobileChat((s) => s.auth);
  const activeId = useMobileChat((s) => s.activeId);
  const chats = useMobileChat((s) => s.chats);
  const devices = useMobileChat((s) => s.devices?.devices);
  const error = useMobileChat((s) => s.error);
  const init = useMobileChat((s) => s.init);
  const newChat = useMobileChat((s) => s.newChat);
  const open = useMobileChat((s) => s.open);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>("chats");
  const drawer = useDrawer();

  useBackHandler(BACK_LAYER.drawer, drawer.open, drawer.closeDrawer);

  const signedIn = Boolean(auth?.signedIn);

  useEffect(() => {
    void init();
    // One subscription for the life of the window: streaming replies, the
    // preview the agent opened, sign-in finishing in the background, and the
    // chats the sync engine pulled while the screen was open.
    const offChat = mobile.onChatEvent((chatId, event) =>
      useMobileChat.getState().handleEvent(chatId, event),
    );
    const offPreview = mobile.onPreview((event) =>
      useMobileChat.getState().handlePreview(event),
    );
    const offAuth = mobile.onAuth((view) =>
      useMobileChat.getState().handleAuth(view),
    );
    const offSync = mobile.onSync((event) =>
      useMobileChat.getState().handleSync(event),
    );
    const offDevices = mobile.onDevices((view) =>
      useMobileChat.getState().handleDevices(view),
    );
    return () => {
      offChat();
      offPreview();
      offAuth();
      offSync();
      offDevices();
    };
  }, [init]);

  // Signing out puts every screen back to the start, so signing back in does
  // not land on an archive or a task screen that was open before.
  useEffect(() => {
    if (!signedIn) {
      setView("chats");
      drawer.closeDrawer();
    }
    // The drawer handles are new on every render; only the account transition
    // should run this.
  }, [signedIn]);

  if (!ready) {
    return <div className="screen splash" aria-busy="true" />;
  }

  if (!signedIn) {
    return <SignIn />;
  }

  const activeChat = chats.find((chat) => chat.id === activeId);
  const machine = activeChat?.remote
    ? devices?.find((device) => device.id === activeChat.deviceId)?.name ??
      activeChat.deviceName ??
      "another machine"
    : null;
  const subtitle =
    view === "workspace"
      ? "Workspace"
      : activeChat
        ? machine
          ? `${activeChat.title} · On ${machine}`
          : activeChat.title
        : null;

  const startNewChat = () => {
    newChat();
    setView("chats");
    drawer.closeDrawer();
  };

  const selectChat = (chatId: string) => {
    void open(chatId);
    setView("chats");
    drawer.closeDrawer();
  };

  const goChats = () => {
    setView("chats");
    drawer.closeDrawer();
  };

  const goWorkspace = () => {
    setView("workspace");
    drawer.closeDrawer();
  };

  const openSettings = () => {
    drawer.closeDrawer();
    setSettingsOpen(true);
  };

  return (
    <div className="app">
      <AppHeader
        onMenu={drawer.openDrawer}
        onNewChat={startNewChat}
        subtitle={subtitle}
      />

      {view === "workspace" ? (
        <WorkspaceTasks />
      ) : activeId ? (
        <Conversation />
      ) : (
        <Home onWorkspace={goWorkspace} onSettings={openSettings} />
      )}

      {error ? (
        <button
          className="toast"
          onClick={() => useMobileChat.setState({ error: null })}
        >
          {error}
        </button>
      ) : null}

      {!drawer.open ? (
        <div
          className="drawer-edge"
          aria-hidden="true"
          {...drawer.edgeProps}
        />
      ) : null}

      <ChatDrawer
        open={drawer.open}
        dragging={drawer.dragging}
        view={view}
        style={drawer.style}
        backdropStyle={drawer.backdropStyle}
        panelProps={drawer.panelProps}
        onClose={drawer.closeDrawer}
        onNewChat={startNewChat}
        onSelectChat={selectChat}
        onChats={goChats}
        onWorkspace={goWorkspace}
        onSettings={openSettings}
      />

      <PreviewSheet />
      {settingsOpen ? (
        <SettingsSheet onClose={() => setSettingsOpen(false)} />
      ) : null}
    </div>
  );
}
