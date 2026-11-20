import { useState } from "react";
import { ChevronLeft, PanelTop } from "lucide-react";

import { Composer, MessageImages, ReportDialog, Thread } from "@hook/chat";

import { mobile } from "../lib/api";
import type { Message } from "../lib/types";
import { useMobileChat } from "../store/useMobileChat";

/**
 * One conversation. Store wiring only, exactly like `apps/chat`'s adapters: the
 * thread, the messages, the composer and the report dialog are the shared ones,
 * so the phone cannot drift from the window.
 */
export function Conversation() {
  const activeId = useMobileChat((s) => s.activeId);
  const messages = useMobileChat((s) => s.messages);
  const chats = useMobileChat((s) => s.chats);
  const streams = useMobileChat((s) => s.streams);
  const activity = useMobileChat((s) => s.activity);
  const draft = useMobileChat((s) => s.draft);
  const setDraft = useMobileChat((s) => s.setDraft);
  const draftImages = useMobileChat((s) => s.draftImages);
  const addDraftImages = useMobileChat((s) => s.addDraftImages);
  const removeDraftImage = useMobileChat((s) => s.removeDraftImage);
  const send = useMobileChat((s) => s.send);
  const stop = useMobileChat((s) => s.stop);
  const back = useMobileChat((s) => s.back);
  const preview = useMobileChat((s) => s.preview);
  const setPreviewOpen = useMobileChat((s) => s.setPreviewOpen);
  const showDetails = useMobileChat((s) => Boolean(s.settings?.advancedMode));

  const [reporting, setReporting] = useState<Message | null>(null);

  const stream = activeId ? streams[activeId] : undefined;
  const labels = activeId ? activity[activeId] : undefined;
  const title =
    chats.find((chat) => chat.id === activeId)?.title ?? "New chat";
  const hasPreview = Boolean(preview?.active && preview.chatId === activeId);
  const busy = Boolean(stream || labels);

  return (
    <section className="screen conversation" aria-label={title}>
      <header className="bar">
        <button className="icon-btn" title="Back" onClick={back}>
          <ChevronLeft strokeWidth={2} />
        </button>
        <div className="bar-title">{title}</div>
        {hasPreview ? (
          <button
            className="icon-btn"
            title="Open the preview"
            onClick={() => setPreviewOpen(true)}
          >
            <PanelTop strokeWidth={1.9} />
          </button>
        ) : (
          <span className="icon-btn-spacer" />
        )}
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

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        onStop={() => void stop()}
        busy={busy}
        images={draftImages}
        // The WebView's own file input opens the camera or the photo library,
        // so attaching a screenshot needs no plugin and no permission string.
        onAddImages={addDraftImages}
        onRemoveImage={removeDraftImage}
        placeholder="Ask anything…"
        className="mobile-composer"
      />

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
