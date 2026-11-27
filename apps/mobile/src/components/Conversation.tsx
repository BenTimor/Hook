import { useState } from "react";
import { PanelTop } from "lucide-react";

import { MessageImages, ReportDialog, Thread } from "@hook/chat";

import { mobile } from "../lib/api";
import { BACK_LAYER, useBackHandler } from "../lib/back";
import type { Message } from "../lib/types";
import { useMobileChat } from "../store/useMobileChat";
import { ChatComposer } from "./ChatComposer";

/**
 * One conversation. Store wiring only, exactly like `apps/chat`'s adapters: the
 * thread, the messages, the composer and the report dialog are the shared ones,
 * so the phone cannot drift from the window.
 *
 * The top bar is `AppHeader`; this screen owns only the thread and the bottom
 * composer, which is what keeps the conversation reading edge to edge even when
 * the keyboard is open.
 */
export function Conversation() {
  const activeId = useMobileChat((s) => s.activeId);
  const messages = useMobileChat((s) => s.messages);
  const chats = useMobileChat((s) => s.chats);
  const streams = useMobileChat((s) => s.streams);
  const activity = useMobileChat((s) => s.activity);
  const preview = useMobileChat((s) => s.preview);
  const setPreviewOpen = useMobileChat((s) => s.setPreviewOpen);
  const back = useMobileChat((s) => s.back);
  const showDetails = useMobileChat((s) => Boolean(s.settings?.advancedMode));

  const [reporting, setReporting] = useState<Message | null>(null);

  // The gesture is the phone's back button: leave the conversation, or close
  // the report dialog when one is open over it.
  useBackHandler(BACK_LAYER.screen, true, back);
  useBackHandler(BACK_LAYER.dialog, Boolean(reporting), () => setReporting(null));

  const stream = activeId ? streams[activeId] : undefined;
  const labels = activeId ? activity[activeId] : undefined;
  const activeChat = chats.find((chat) => chat.id === activeId);
  const coding = activeChat?.kind === "coding";
  const hasPreview = Boolean(preview?.active && preview.chatId === activeId);

  return (
    <section className="screen conversation" aria-label={activeChat?.title ?? "Conversation"}>
      {hasPreview ? (
        <div className="conversation-tools">
          <button
            className="conversation-preview"
            onClick={() => setPreviewOpen(true)}
          >
            <PanelTop strokeWidth={1.9} />
            Preview
          </button>
        </div>
      ) : null}

      <Thread
        messages={messages}
        streamText={stream?.text}
        streamReasoning={stream?.reasoning}
        activity={labels}
        showDetails={showDetails}
        finalOnly={!coding}
        onReport={setReporting}
        renderExtras={(message) => (
          <MessageImages
            chatId={activeId}
            attachments={message.attachments ?? []}
            load={mobile.readImage}
          />
        )}
        className="mobile-thread"
      />

      <ChatComposer className="mobile-composer" />

      {reporting && activeId ? (
        <ReportDialog
          messages={messages}
          onClose={() => setReporting(null)}
          submit={(input) =>
            mobile.reportMessage({
              chatId: activeId,
              messageId: reporting.id,
              reason: input.reason,
              note: input.note,
              content: reporting.content,
              transcript: input.transcript,
            })
          }
        />
      ) : null}
    </section>
  );
}
