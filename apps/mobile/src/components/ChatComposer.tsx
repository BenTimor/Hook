import { useRef, useState, type RefObject } from "react";
import { Camera, FileText, Image as ImageIcon, X } from "lucide-react";

import { Composer, fileToDraftImage, type DraftImage } from "@hook/chat";

import { BACK_LAYER, useBackHandler } from "../lib/back";
import { useMobileChat } from "../store/useMobileChat";

/**
 * The composer, wired to the phone's store.
 *
 * The home screen and a conversation draw the same input — a new chat is just
 * a conversation with no id yet — so this adapter lives in one place rather
 * than being copied into both screens. The image picker is the WebView's own
 * file input, which is the native photo sheet; the small menu in front of it
 * only chooses between the library, the camera and the file picker.
 */
export function ChatComposer({ className }: { className?: string }) {
  const activeId = useMobileChat((s) => s.activeId);
  const streams = useMobileChat((s) => s.streams);
  const activity = useMobileChat((s) => s.activity);
  const draft = useMobileChat((s) => s.draft);
  const setDraft = useMobileChat((s) => s.setDraft);
  const draftImages = useMobileChat((s) => s.draftImages);
  const addDraftImages = useMobileChat((s) => s.addDraftImages);
  const removeDraftImage = useMobileChat((s) => s.removeDraftImage);
  const focusKey = useMobileChat((s) => s.composerFocus);
  const send = useMobileChat((s) => s.send);
  const stop = useMobileChat((s) => s.stop);
  const commands = useMobileChat((s) => s.commands);
  const activeChat = useMobileChat((s) => s.chats.find((chat) => chat.id === s.activeId));
  const coding = activeChat?.kind === "coding";
  // Every coding chat on a phone lives on another machine, and the relay
  // carries the message, not the picture: the backend refuses one there, so
  // the button is not offered.
  const pictures = !coding && !activeChat?.remote;

  const [attachOpen, setAttachOpen] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  useBackHandler(BACK_LAYER.sheet, attachOpen, () => setAttachOpen(false));

  const busy = Boolean(activeId && (streams[activeId] || activity[activeId]));

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const staged = await Promise.all(Array.from(files).map(fileToDraftImage));
    const usable = staged.filter((image): image is DraftImage => image !== null);
    if (usable.length) addDraftImages(usable);
  };

  const choose = (input: RefObject<HTMLInputElement | null>) => {
    setAttachOpen(false);
    input.current?.click();
  };

  return (
    <>
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        onStop={() => void stop()}
        busy={busy}
        // A coding chat accepts a message while the engine works: it steers the
        // run instead of waiting.
        steer={coding}
        images={draftImages}
        // The WebView's own file input opens the native photo sheet; the camera
        // input uses the same picker with `capture`.
        onAddImages={pictures ? addDraftImages : undefined}
        onRemoveImage={removeDraftImage}
        onAttach={pictures ? () => setAttachOpen(true) : undefined}
        placeholder={coding ? "Message the coding agent…" : "Ask Hook anything..."}
        hint={null}
        focusKey={focusKey}
        commands={commands}
        className={className}
      />

      <input
        ref={photoInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          void addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          void addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {attachOpen ? (
        <div
          className="sheet-backdrop"
          onMouseDown={() => setAttachOpen(false)}
        >
          <div
            className="sheet sheet-actions"
            role="dialog"
            aria-modal="true"
            aria-label="Add to chat"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheet-grip" aria-hidden="true" />
            <header className="sheet-head">
              <div className="sheet-heading">
                <div className="sheet-title">Add to chat</div>
                <div className="sheet-note">Photos are sent with your message.</div>
              </div>
              <button
                className="icon-btn"
                title="Close"
                aria-label="Close"
                onClick={() => setAttachOpen(false)}
              >
                <X strokeWidth={2} />
              </button>
            </header>
            <div className="sheet-body actions">
              <button className="action" onClick={() => choose(photoInput)}>
                <ImageIcon strokeWidth={1.8} />
                Photo Library
              </button>
              <button className="action" onClick={() => choose(cameraInput)}>
                <Camera strokeWidth={1.8} />
                Camera
              </button>
              <button
                className="action"
                disabled
                title="File attachments are not available yet."
              >
                <FileText strokeWidth={1.8} />
                Choose File
                <span className="action-badge">Soon</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
