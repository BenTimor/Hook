import { useState } from "react";

import { Thread as SharedThread } from "@hook/chat";

import { useChatStore } from "../store/useChatStore";
import type { Message } from "../lib/types";
import { isCodingChat } from "../lib/utils";
import { MessageImages } from "./MessageImages";
import { ReportDialog } from "./ReportDialog";

/**
 * The chat app's conversation: store wiring only.
 *
 * The thread, the messages and the composer live in `@hook/chat` so a docked
 * panel in another product renders exactly what this window renders. What is
 * left here is what only this app can answer — which store, which pictures and
 * where a report goes.
 */
export function Thread() {
  const messages = useChatStore((s) => s.messages);
  const activeId = useChatStore((s) => s.activeId);
  const streamText = useChatStore((s) =>
    s.activeId ? s.streams[s.activeId]?.text : undefined,
  );
  const streamReasoning = useChatStore((s) =>
    s.activeId ? s.streams[s.activeId]?.reasoning : undefined,
  );
  const showDetails = useChatStore((s) => Boolean(s.settings?.advancedMode));
  const activity = useChatStore((s) =>
    s.activeId ? s.activity[s.activeId] : undefined,
  );
  const regenerate = useChatStore((s) => s.regenerate);
  const edit = useChatStore((s) => s.edit);
  // A coding agent's replies come from the folder, and its conversation is the
  // engine's own session: there is nothing for Hook to regenerate or rewrite.
  const coding = useChatStore((s) =>
    isCodingChat(s.chats.find((chat) => chat.id === s.activeId)),
  );

  // One dialog for the conversation, not one per message.
  const [reporting, setReporting] = useState<Message | null>(null);

  return (
    <>
      <SharedThread
        messages={messages}
        streamText={streamText}
        streamReasoning={streamReasoning}
        activity={activity}
        showDetails={showDetails}
        finalOnly={!coding}
        onRegenerate={coding ? undefined : () => void regenerate()}
        onEdit={coding ? undefined : (id, text) => void edit(id, text)}
        onReport={setReporting}
        renderExtras={(message) => <MessageImages message={message} />}
      />
      {reporting && activeId ? (
        <ReportDialog
          chatId={activeId}
          message={reporting}
          onClose={() => setReporting(null)}
        />
      ) : null}
    </>
  );
}
