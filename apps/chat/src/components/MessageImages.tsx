import { MessageImages as SharedMessageImages } from "@hook/chat";

import { api } from "../lib/bridge";
import { useChatStore } from "../store/useChatStore";
import type { Message } from "../lib/types";

/**
 * The chat window's pictures: which chat, and where bytes come from.
 *
 * Everything visible — the strip, the lightbox, the cache — lives in
 * `packages/chat`, so the dock and the phone draw the same thing.
 */
export function MessageImages({ message }: { message: Message }) {
  const chatId = useChatStore((s) => s.activeId);
  const attachments = message.attachments ?? [];

  return (
    <SharedMessageImages
      chatId={chatId}
      attachments={attachments}
      load={api.readImage}
      onOpen={(attachment) => api.openImage(chatId ?? "", attachment.id)}
      onSaveAs={async (attachment, suggestedName) => {
        const saved = await api.saveImageAs(chatId ?? "", attachment.id, suggestedName);
        return saved ? suggestedName : null;
      }}
    />
  );
}
