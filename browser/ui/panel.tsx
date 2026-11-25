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

// How long the dock keeps asking for a channel before it settles for the local
// conversation: 20 x 1.5 s. The browser launches its host on demand and a fresh
// Windows process takes a second or two to bind, so the first answer is often
// "not yet" — and a panel that turns that into a permanent mock is a panel that
// says "Hook is not listening on this computer" to someone looking at Hook.
const CONNECT_ATTEMPTS = 20;
const CONNECT_DELAY_MS = 1500;

async function boot(): Promise<void> {
  const host = document.getElementById("dock");
  if (!host) return;

  const root = createRoot(host);
  const draw = (transport: ReturnType<typeof channelTransport> | ReturnType<typeof localTransport>) => {
    root.render(
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
  };

  const handler = await hookHandler();
  if (!handler) {
    draw(localTransport(NO_APP));
    return;
  }

  // A side panel entry stays hidden until its page says it is ready; in a tab
  // this is a no-op. Said before connecting, or the panel would stay hidden for
  // as long as the retry loop runs.
  handler.showUI();

  // Draw immediately, then keep asking: the dock is a live surface and a stale
  // descriptor, a host that is still starting or a restart with a new port are
  // all answered by asking again a moment later (`docs/browser-host.md`).
  draw(localTransport("Starting Hook…"));
  let reason = "";
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
    try {
      const channel = await handler.getChannel();
      if (channel.available) {
        draw(channelTransport(handler));
        return;
      }
      reason = channel.reason || "";
    } catch (failure) {
      // A mojo call can reject while the page is still binding its handler. That
      // is a "not yet", not the end of the dock.
      reason = String(failure);
    }
    // Nothing will ever answer: a refused launch is not a slow launch.
    if (attempt > 0 && /not installed|not running/i.test(reason)) break;
    await new Promise((done) => setTimeout(done, CONNECT_DELAY_MS));
  }
  draw(localTransport(reason || NO_APP));
}

void boot();
