import { useState } from "react";

import { Thread as SharedThread } from "@hook/chat";

import { useChatStore } from "../store/useChatStore";
import type { Message } from "../lib/types";
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
  const regenerate = useChatStore((s) => s.regenerate);
  const edit = useChatStore((s) => s.edit);

  // One dialog for the conversation, not one per message.
  const [reporting, setReporting] = useState<Message | null>(null);

  return (
    <>
      <SharedThread
        messages={messages}
        streamText={streamText}
        onRegenerate={() => void regenerate()}
        onEdit={(id, text) => void edit(id, text)}
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
