import { Composer } from "@hook/chat";

import { useMobileChat } from "../store/useMobileChat";

/**
 * The composer, wired to the phone's store.
 *
 * The home screen and a conversation draw the same input — a new chat is just
 * a conversation with no id yet — so this adapter lives in one place rather
 * than being copied into both screens.
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
  const send = useMobileChat((s) => s.send);
  const stop = useMobileChat((s) => s.stop);
  const coding = useMobileChat(
    (s) => s.chats.find((chat) => chat.id === s.activeId)?.kind === "coding",
  );

  const busy = Boolean(
    activeId && (streams[activeId] || activity[activeId]),
  );

  return (
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
      // The WebView's own file input opens the camera or the photo library,
      // so attaching a screenshot needs no plugin and no permission string. A
      // coding agent talks in text.
      onAddImages={coding ? undefined : addDraftImages}
      onRemoveImage={removeDraftImage}
      placeholder={coding ? "Message the coding agent…" : "Ask anything…"}
      className={className}
    />
  );
}
