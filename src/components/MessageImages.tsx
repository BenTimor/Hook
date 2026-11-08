import { useEffect, useState } from "react";

import { api } from "../lib/bridge";
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
    <div className="msg-images" data-count={Math.min(attachments.length, 2)}>
      {attachments.map((attachment) => {
        const url = urls[attachment.id];
        const tall = attachment.height > attachment.width * 2;
        return (
          <a
            className="msg-image"
            data-tall={tall || undefined}
            key={attachment.id}
            href={url || undefined}
            target="_blank"
            rel="noreferrer"
            title={attachment.width ? `${attachment.width}×${attachment.height}` : "Image"}
          >
            {url ? (
              <img src={url} alt="" loading="lazy" />
            ) : (
              <span className="msg-image-placeholder" />
            )}
          </a>
        );
      })}
    </div>
  );
}
