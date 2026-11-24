/**
 * The Hook chat panel, mounted into `chrome://hook` and `chrome://hook-panel`.
 *
 * This is the Step 2 surface of docs/browser-poc-plan.md: not a browser-only
 * chat, but `ChatDock` from `packages/chat` on `packages/ui` tokens, built by
 * Vite into the static bundle the overlay serves from its pak. Chromium's own
 * WebUI pipeline is Lit and ships no React; rewriting the dock in Lit would fork
 * the surface all three Hook products share.
 *
 * Which transport it gets is decided here, once: a running Hook app means the
 * user's real conversations (over mojom, through the app's loopback channel);
 * no app means a local conversation that says so.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// The component, not the package index: `@hook/chat` also re-exports the
// preview, the machines list and the remote-chat picker, and a WebUI bundle is
// a committed file, so it carries only what this page draws.
import { ChatDock } from "../../packages/chat/src/ChatDock";
import { SignInCard, type SignInCardProps } from "@hook/ui";
import "@hook/ui/tokens.css";

import { hookHandler } from "./mojom";
import { channelTransport, localTransport } from "./transport";

const NO_APP = "Hook is not running on this computer.";

/**
 * The sign-in card, mounted by `hook.ts` when the page has no session.
 *
 * Exported from this bundle rather than built as a second one: Vite would split
 * the React runtime into a chunk the pak would also have to carry, and a WebUI
 * resource is addressed by a path, not by a chunk graph.
 *
 * The flow belongs to the page, not to the card: `chrome://hook` is what can ask
 * the browser process for the state and poll the running app's channel, and the
 * card is only the face of it.
 */
export interface MountedSignIn {
  update(props: SignInCardProps): void;
}

export function mountSignIn(
  host: HTMLElement,
  props: SignInCardProps,
): MountedSignIn {
  const root = createRoot(host);
  const draw = (next: SignInCardProps) => {
    root.render(
      <StrictMode>
        <SignInCard {...next} />
      </StrictMode>,
    );
  };
  draw(props);
  return { update: draw };
}

async function boot(): Promise<void> {
  const host = document.getElementById("dock");
  if (!host) return;

  let transport = localTransport(NO_APP);
  const handler = await hookHandler();
  if (handler) {
    // A side panel entry stays hidden until its page says it is ready; in a tab
    // this is a no-op.
    handler.showUI();
    const channel = await handler.getChannel();
    transport = channel.available
      ? channelTransport(handler)
      : localTransport(channel.reason || NO_APP);
  }

  createRoot(host).render(
    <StrictMode>
      <ChatDock
        transport={transport}
        open
        onClose={() => {
          // The pane is the page in this POC; the side panel's own button (or
          // pin) is what closes it there.
        }}
        suggestions={[
          "What is this page for?",
          "Which tab am I on?",
          "What is left in Step 1?",
        ]}
        blurb="The chat from Hook, in the browser."
      />
    </StrictMode>,
  );
}

void boot();
