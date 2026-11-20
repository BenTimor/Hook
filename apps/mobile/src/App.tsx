import { useEffect, useState } from "react";

import { mobile } from "./lib/api";
import { useMobileChat } from "./store/useMobileChat";
import { ChatList } from "./components/ChatList";
import { Conversation } from "./components/Conversation";
import { PreviewSheet } from "./components/PreviewSheet";
import { SettingsSheet } from "./components/SettingsSheet";
import { SignIn } from "./components/SignIn";

/**
 * Hook on a phone.
 *
 * Two screens and two sheets. The chat surface, the composer, the report dialog
 * and the Workspace preview all come from `@hook/chat`; what is here is the
 * phone's own chrome — a list instead of a sidebar, sheets instead of a side
 * panel, and safe-area padding.
 */
export function App() {
  const ready = useMobileChat((s) => s.ready);
  const auth = useMobileChat((s) => s.auth);
  const activeId = useMobileChat((s) => s.activeId);
  const composing = useMobileChat((s) => s.composing);
  const error = useMobileChat((s) => s.error);
  const init = useMobileChat((s) => s.init);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void init();
    // One subscription for the life of the window: streaming replies, the
    // preview the agent opened, and sign-in finishing in the background.
    const offChat = mobile.onChatEvent((chatId, event) =>
      useMobileChat.getState().handleEvent(chatId, event),
    );
    const offPreview = mobile.onPreview((event) =>
      useMobileChat.getState().handlePreview(event),
    );
    const offAuth = mobile.onAuth((view) => useMobileChat.setState({ auth: view }));
    return () => {
      offChat();
      offPreview();
      offAuth();
    };
  }, [init]);

  if (!ready) {
    return <div className="screen splash" aria-busy="true" />;
  }

  if (!auth?.signedIn) {
    return <SignIn />;
  }

  return (
    <div className="app">
      {activeId || composing ? (
        <Conversation />
      ) : (
        <ChatList onSettings={() => setSettingsOpen(true)} />
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
