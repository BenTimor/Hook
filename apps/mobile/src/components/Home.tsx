import { useEffect, useState } from "react";
import { Code2, FileText, History, Lightbulb, Settings, SquareTerminal } from "lucide-react";

import { greeting, RemoteChatDialog } from "@hook/chat";
import { HookMark } from "@hook/ui";

import { mobile } from "../lib/api";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import { useMobileChat } from "../store/useMobileChat";
import { ChatComposer } from "./ChatComposer";

const SUGGESTIONS = [
  { icon: Lightbulb, label: "Explain a tricky concept simply" },
  { icon: Code2, label: "Debug this snippet with me" },
  { icon: FileText, label: "Draft release notes for v2" },
];

/**
 * The home screen: a new conversation, not the archive.
 *
 * Like the desktop window, what opens first is the composer with a greeting;
 * the conversations are one tap away behind the history button. Sending here
 * creates the chat, and the same screen becomes its conversation.
 *
 * Starting a coding agent on a computer is an advanced-mode action, exactly as
 * it is on the desktop: with advanced off, the chat agent gets the work and
 * decides for itself whether a machine is needed. The phone does not offer a
 * second, simpler way into the same agent.
 */
export function Home({
  onChats,
  onSettings,
}: {
  onChats: () => void;
  onSettings: () => void;
}) {
  const setDraft = useMobileChat((s) => s.setDraft);
  const devices = useMobileChat((s) => s.devices);
  const advanced = useMobileChat((s) => Boolean(s.settings?.advancedMode));
  const newRemoteCodingChat = useMobileChat((s) => s.newRemoteCodingChat);
  const [remoteOpen, setRemoteOpen] = useState(false);
  // The Android back gesture closes the picker before it leaves the screen.
  useBackHandler(BACK_LAYER.dialog, remoteOpen, () => setRemoteOpen(false));
  useEffect(() => {
    // Turning advanced off elsewhere (the computer, the settings sheet) must
    // close a picker that is already open.
    if (!advanced) setRemoteOpen(false);
  }, [advanced]);
  const hosts =
    devices?.devices.filter(
      (device) =>
        device.id !== devices.selfId &&
        device.canHost &&
        device.hostOnline &&
        device.remoteAllowed,
    ) ?? [];

  return (
    <section className="screen home" aria-label="New chat">
      <header className="bar bar-root">
        <div className="bar-brand">
          <HookMark />
          <span>Hook</span>
        </div>
        <div className="bar-actions">
          <button
            className="icon-btn"
            title="Your chats"
            aria-label="Your chats"
            onClick={onChats}
          >
            <History strokeWidth={1.8} />
          </button>
          <button
            className="icon-btn"
            title="Settings"
            aria-label="Settings"
            onClick={onSettings}
          >
            <Settings strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <div className="hero">
        <div className="hero-inner">
          <h1>{greeting()}</h1>
          <p>Ask anything. Nothing leaves this phone unless your plan syncs it.</p>
          <ChatComposer className="mobile-composer" />
          <div className="chips">
            {advanced && hosts.length > 0 && (
              <button
                className="chip chip-machine"
                onClick={() => setRemoteOpen(true)}
              >
                <SquareTerminal strokeWidth={1.7} />
                Code on {hosts[0].name}
              </button>
            )}
            {SUGGESTIONS.map(({ icon: Icon, label }) => (
              <button
                key={label}
                className="chip"
                onClick={() => setDraft(label)}
              >
                <Icon strokeWidth={1.7} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {advanced && remoteOpen && (
        <RemoteChatDialog
          devices={devices?.devices ?? []}
          selfId={devices?.selfId ?? ""}
          onClose={() => setRemoteOpen(false)}
          loadProjects={mobile.remoteProjects}
          createProject={mobile.createRemoteProject}
          loadFolders={mobile.remoteFolders}
          onCreate={(deviceId, target) =>
            newRemoteCodingChat(deviceId, target)
          }
        />
      )}
    </section>
  );
}
