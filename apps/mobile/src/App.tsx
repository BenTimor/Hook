import { useEffect, useState } from "react";

import { mobile } from "./lib/api";
import { useMobileChat } from "./store/useMobileChat";
import { ChatList } from "./components/ChatList";
import { Conversation } from "./components/Conversation";
import { Home } from "./components/Home";
import { PreviewSheet } from "./components/PreviewSheet";
import { SettingsSheet } from "./components/SettingsSheet";
import { SignIn } from "./components/SignIn";

/**
 * Hook on a phone.
 *
 * Two destinations and two sheets: the home screen is a new conversation,
 * opening an archived one is the same conversation screen, and the list is a
 * layer behind the history button on either one. The chat surface, the
 * composer, the report dialog and the Workspace preview all come from
 * `@hook/chat`; what is here is the phone's own chrome — a list instead of a
 * sidebar, sheets instead of a side panel, and safe-area padding.
 */
export function App() {
  const ready = useMobileChat((s) => s.ready);
  const auth = useMobileChat((s) => s.auth);
  const activeId = useMobileChat((s) => s.activeId);
  const error = useMobileChat((s) => s.error);
  const init = useMobileChat((s) => s.init);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);

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
  // not land on an archive that was open before.
  useEffect(() => {
    if (!signedIn) setListOpen(false);
  }, [signedIn]);

  if (!ready) {
    return <div className="screen splash" aria-busy="true" />;
  }

  if (!signedIn) {
    return <SignIn />;
  }

  return (
    <div className="app">
      {listOpen ? (
        <ChatList
          onBack={() => setListOpen(false)}
          onSettings={() => setSettingsOpen(true)}
        />
      ) : activeId ? (
        <Conversation onChats={() => setListOpen(true)} />
      ) : (
        <Home
          onChats={() => setListOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
      )}
      {error ? (
        <button
          className="toast"
          onClick={() => useMobileChat.setState({ error: null })}
        >
          {error}
        </button>
      ) : null}
      <PreviewSheet />
      {settingsOpen ? <SettingsSheet onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
