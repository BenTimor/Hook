/**
 * The Hook chat panel, mounted into `chrome://hook`.
 *
 * This is the Step 2 surface of docs/browser-poc-plan.md: not a browser-only
 * chat, but `ChatDock` from `packages/chat` on `packages/ui` tokens, built by
 * Vite into the static bundle the overlay serves from its pak. Chromium's own
 * WebUI pipeline is Lit and ships no React; rewriting the dock in Lit would fork
 * the surface all three Hook products share.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// The component, not the package index: `@hook/chat` also re-exports the
// preview, the machines list and the remote-chat picker, and a WebUI bundle is
// a committed file, so it carries only what this page draws.
import { ChatDock } from "../../packages/chat/src/ChatDock";
import "@hook/ui/tokens.css";

import { panelTransport } from "./transport";

const host = document.getElementById("dock");
if (host) {
  createRoot(host).render(
    <StrictMode>
      <ChatDock
        transport={panelTransport}
        open
        onClose={() => {
          // The pane is the page in this POC; Step 2's side panel gives it a
          // toggle that collapses it instead of unmounting the page.
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
