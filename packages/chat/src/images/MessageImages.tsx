import { useEffect, useState } from "react";

import { Lightbox } from "./Lightbox";
import type { ChatAttachment } from "./types";
import "./images.css";

/** Bytes live on disk, so each picture is read back once and kept for the session. */
const cache = new Map<string, string>();

export interface MessageImagesProps {
  chatId: string | null;
  attachments: ChatAttachment[];
  /** Read one attachment as a data URL. The only bit a product must supply. */
  load: (chatId: string, attachmentId: string) => Promise<string>;
  onOpen?: (attachment: ChatAttachment) => Promise<void>;
  /** A copy in a folder the user will find, with no dialog. Answers the path. */
  onSave?: (attachment: ChatAttachment) => Promise<string>;
  onSaveAs?: (attachment: ChatAttachment, suggestedName: string) => Promise<string | null>;
}

/**
 * Pictures attached to a message, with the lightbox.
 *
 * The dock, the chat window and the phone all draw the same strip; what differs
 * is where the bytes are read from, which is why `load` is a prop and the cache
 * is keyed by attachment id alone.
 */
export function MessageImages({
  chatId,
  attachments,
  load,
  onOpen,
  onSave,
  onSaveAs,
}: MessageImagesProps) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (attachments.length === 0) return;
    if (!chatId) return;
    let cancelled = false;
    void Promise.all(
      attachments.map(async (attachment) => {
        const cached = cache.get(attachment.id);
        if (cached) return [attachment.id, cached] as const;
        const url = await load(chatId, attachment.id).catch(() => "");
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
  }, [chatId, attachments, load]);

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
          attachments={attachments}
          urls={urls}
          startIndex={open}
          onClose={() => setOpen(null)}
          onOpen={onOpen}
          onSave={onSave}
          onSaveAs={onSaveAs}
        />
      )}
    </>
  );
}
