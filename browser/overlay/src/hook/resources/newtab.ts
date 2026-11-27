// Hook Browser: the new tab page's one behaviour.
//
// A greeting that is true of the clock, drawn from the catalog every Hook
// product uses. Chromium's WebUI pipeline cannot import `packages/chat`, so
// `browser/tools/build.mjs` copies `packages/chat/src/greeting.ts` here as
// `greeting.generated.ts` before the build. The copy is generated, not
// committed: editing the catalog is still one file, in `packages/chat`.
//
// Nothing else is dynamic: the chips are links, and a page that greets you and
// gets out of the way does not need a framework. When the page grows a real job
// (recent chats, a search box) this is where the mojom seam already exists —
// `chrome://hook` is a page away.

import { greeting } from './greeting.generated.js';

const heading = document.querySelector<HTMLHeadingElement>('#greeting');

if (heading) {
  heading.textContent = greeting();
}
