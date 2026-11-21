import { useState } from "react";
import { ChevronLeft, History, PanelTop } from "lucide-react";

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
 */
export function Conversation({ onChats }: { onChats: () => void }) {
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
  const title =
    chats.find((chat) => chat.id === activeId)?.title ?? "New chat";
  const hasPreview = Boolean(preview?.active && preview.chatId === activeId);

  return (
    <section className="screen conversation" aria-label={title}>
      <header className="bar">
        <button className="icon-btn" title="Back" onClick={back}>
          <ChevronLeft strokeWidth={2} />
        </button>
        <div className="bar-title">{title}</div>
        <div className="bar-actions">
          {hasPreview ? (
            <button
              className="icon-btn"
              title="Open the preview"
              onClick={() => setPreviewOpen(true)}
            >
              <PanelTop strokeWidth={1.9} />
            </button>
          ) : null}
          <button
            className="icon-btn"
            title="Your chats"
            aria-label="Your chats"
            onClick={onChats}
          >
            <History strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <Thread
        messages={messages}
        streamText={stream?.text}
        streamReasoning={stream?.reasoning}
        activity={labels}
        showDetails={showDetails}
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
