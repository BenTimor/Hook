/** A picture attached to a message, as both products store it. */
export interface ChatAttachment {
  id: string;
  /** The file's stem inside the chat's image folder; the bytes stay on disk. */
  file: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** "user" or "screenshot" — purely cosmetic. */
  kind?: string;
  /** Content address used by the sync service. */
  sha256?: string;
}
