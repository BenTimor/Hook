import { useEffect, useState } from "react";
import { Cloud, Code2, Lightbulb, SquareTerminal } from "lucide-react";

import { greeting, RemoteChatDialog } from "@hook/chat";
import { HookMark } from "@hook/ui";

import { mobile } from "../lib/api";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import { useMobileChat } from "../store/useMobileChat";
import { ChatComposer } from "./ChatComposer";

const SUGGESTIONS = [
  {
    Icon: Lightbulb,
    label: "Explain something to me",
    prompt: "Explain something to me: ",
  },
  {
    Icon: Code2,
    label: "Help me with code",
    prompt: "Help me with code: ",
  },
] as const;

/**
 * The welcome screen: a conversation with no id yet.
 *
 * It is deliberately not a dashboard. The greeting and the quiet rows are the
 * whole content; the composer is the action. A suggestion only stages its
 * prompt, so the person can edit it before sending. Tasks are the exception:
 * they open Workspace, where the real task data lives.
 */
export function Home({
  onWorkspace,
  onSettings,
}: {
  onWorkspace: () => void;
  onSettings: () => void;
}) {
  const auth = useMobileChat((s) => s.auth);
  const setDraft = useMobileChat((s) => s.setDraft);
  const focusComposer = useMobileChat((s) => s.focusComposer);
  const sync = useMobileChat((s) => s.sync);
  const devices = useMobileChat((s) => s.devices);
  const advanced = useMobileChat((s) => Boolean(s.settings?.advancedMode));
  const newRemoteCodingChat = useMobileChat((s) => s.newRemoteCodingChat);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);

  const hosts =
    devices?.devices.filter(
      (device) =>
        device.id !== devices.selfId &&
        device.canHost &&
        device.hostOnline &&
        device.remoteAllowed,
    ) ?? [];

  useBackHandler(BACK_LAYER.dialog, remoteOpen, () => setRemoteOpen(false));
  useEffect(() => {
    if (!advanced) setRemoteOpen(false);
  }, [advanced]);

  const stage = (prompt: string) => {
    setDraft(prompt);
    focusComposer();
  };

  const syncOn = Boolean(sync?.enabled);
  const syncStatus = syncOn
    ? sync?.state === "syncing"
      ? "Cloud sync is on · syncing"
      : "Cloud sync is on"
    : "Chats saved on this device";

  return (
    <section
      className="screen home"
      data-focused={composerFocused || undefined}
      aria-label="New chat"
    >
      <div className="home-scroll">
        <div className="home-body">
          <div className="home-empty">
            <h1>{greeting(auth?.name)}</h1>
            <p>What can I help you with today?</p>
          </div>
        </div>

        <div className="home-suggestions">
          {SUGGESTIONS.map(({ Icon, label, prompt }) => (
            <button
              key={label}
              className="home-suggestion"
              onClick={() => stage(prompt)}
            >
              <Icon
                className="home-suggestion-icon"
                strokeWidth={1.7}
                aria-hidden="true"
              />
              <span>{label}</span>
            </button>
          ))}
          <button className="home-suggestion" onClick={onWorkspace}>
            <HookMark className="home-suggestion-icon home-suggestion-mark" />
            <span>Show my tasks</span>
          </button>
          {advanced && hosts.length > 0 ? (
            <button
              className="home-suggestion"
              onClick={() => setRemoteOpen(true)}
            >
              <SquareTerminal
                className="home-suggestion-icon"
                strokeWidth={1.7}
                aria-hidden="true"
              />
              <span>Code on {hosts[0].name}</span>
            </button>
          ) : null}
        </div>

        <div className="home-sync">
          <span className="home-sync-line">
            <Cloud strokeWidth={1.7} />
            {syncStatus}
          </span>
          <button className="home-sync-action" onClick={onSettings}>
            {syncOn ? "Manage" : "Enable Cloud Sync"}
          </button>
        </div>
      </div>

      <div className="home-composer">
        <ChatComposer
          className="mobile-composer"
          onFocusChange={setComposerFocused}
        />
      </div>

      {advanced && remoteOpen && (
        <RemoteChatDialog
          devices={devices?.devices ?? []}
          selfId={devices?.selfId ?? ""}
          onClose={() => setRemoteOpen(false)}
          loadProjects={mobile.remoteProjects}
          createProject={mobile.createRemoteProject}
          loadFolders={mobile.remoteFolders}
          pinFolder={mobile.pinRemoteFolder}
          onCreate={(deviceId, target) => newRemoteCodingChat(deviceId, target)}
        />
      )}
    </section>
  );
}
