import { useChatStore } from "../store/useChatStore";
import { Composer as SharedComposer } from "@hook/chat";
import { useSteering } from "../lib/agents";
import { isCodingChat } from "../lib/utils";

/**
 * The chat app's input: store wiring only. Everything you can see or do to the
 * box lives in `@hook/chat`, so it is the same composer in a product's dock.
 */
export function Composer() {
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const activeId = useChatStore((s) => s.activeId);
  const streaming = useChatStore((s) =>
    s.activeId ? Boolean(s.streams[s.activeId] || s.activity[s.activeId]) : false,
  );
  const ready = useChatStore((s) => s.ready);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const focusToken = useChatStore((s) => s.focusToken);
  const draftImages = useChatStore((s) => s.draftImages);
  const addDraftImages = useChatStore((s) => s.addDraftImages);
  const removeDraftImage = useChatStore((s) => s.removeDraftImage);
  // While an agent works, the composer is mostly a steering wheel: the chat
  // agent hands what you type to the coding agent instead of starting new work.
  const steering = useSteering();
  const coding = useChatStore((s) =>
    isCodingChat(s.chats.find((chat) => chat.id === s.activeId)),
  );

  return (
    <SharedComposer
      value={draft}
      onChange={setDraft}
      onSend={() => void send(draft.trim())}
      onStop={() => void stop()}
      busy={streaming}
      // A coding-agent chat is a conversation even while it works: what you
      // type steers the run, and Stop stays beside Send.
      steer={coding}
      ready={ready}
      images={draftImages}
      // The coding engine reads text. Offering a picture here would promise
      // something that cannot be delivered.
      onAddImages={coding ? undefined : addDraftImages}
      onRemoveImage={coding ? undefined : removeDraftImage}
      placeholder={
        coding
          ? streaming
            ? "Steer the agent…"
            : "Tell the agent what to do…"
          : steering
            ? "Steer the agent…"
            : "Ask anything…"
      }
      hint={
        steering ? (
          <>Enter to send · your message steers the working agent</>
        ) : undefined
      }
      focusKey={`${activeId ?? "new"}:${focusToken}`}
    />
  );
}
