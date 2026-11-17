import { useEffect, useState } from "react";

import { api } from "../lib/bridge";
import { Lightbox } from "./Lightbox";
import { useChatStore } from "../store/useChatStore";
import type { Message } from "../lib/types";

/**
 * Pictures attached to a message. The bytes live on disk, so each one is read
 * back once and cached for the session.
 */
const cache = new Map<string, string>();

export function MessageImages({ message }: { message: Message }) {
  const chatId = useChatStore((s) => s.activeId);
  const attachments = message.attachments ?? [];
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (attachments.length === 0) return;
    let cancelled = false;
    void Promise.all(
      attachments.map(async (attachment) => {
        const cached = cache.get(attachment.id);
        if (cached) return [attachment.id, cached] as const;
        const url = chatId
          ? await api.readImage(chatId, attachment.id).catch(() => "")
          : "";
        if (url) cache.set(attachment.id, url);
        return [attachment.id, url] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setUrls(Object.fromEntries(entries.filter(([, url]) => url)));
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, attachments]);

  if (attachments.length === 0) return null;

  return (
    <>
      <div className="msg-images" data-count={Math.min(attachments.length, 2)}>
        {attachments.map((attachment, index) => {
          const url = urls[attachment.id];
          const tall = attachment.height > attachment.width * 2;
          return (
            <button
              className="msg-image"
              data-tall={tall || undefined}
              key={attachment.id}
              type="button"
              disabled={!url}
              title={
                attachment.width
                  ? `${attachment.width}×${attachment.height} — click to enlarge`
                  : "Click to enlarge"
              }
              onClick={() => setOpen(index)}
            >
              {url ? (
                <img src={url} alt="" loading="lazy" draggable={false} />
              ) : (
                <span className="msg-image-placeholder" />
              )}
            </button>
          );
        })}
      </div>

      {open !== null && (
        <Lightbox
          chatId={chatId}
          attachments={attachments}
          urls={urls}
          startIndex={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
