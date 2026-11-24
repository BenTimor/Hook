// Hook Browser: chrome://hook.
//
// The page has two faces, and which one it shows is the whole sign-in gate:
//
// * signed out — the shared sign-in card (`packages/ui/src/SignInCard.tsx`,
//   mounted from `panel.mjs`), offering the device flow through the running Hook
//   app. The browser cannot sign in on its own: the account file is `auth.rs`'s,
//   written by the app, and the browser only reads it.
// * signed in — the browser's own page: the live tab list over mojom, and the
//   dock from `packages/chat` at the 380px the desktop products give it.
//
// The navigation gate (`hook_sign_in_throttle.cc`) is what actually keeps the web
// out; this page is what the gate sends a person to. They share one account read
// (`hook_account.cc`), so a reload after approval is let through immediately.

import {PageHandler} from './hook.mojom-webui.js';
import type {SignInView, Tab} from './hook.mojom-webui.js';

const gate = document.querySelector<HTMLDivElement>('#gate');
const seam = document.querySelector<HTMLElement>('#seam');
const status = document.querySelector<HTMLParagraphElement>('#status');
const list = document.querySelector<HTMLOListElement>('#tabs');

// Compiled by tsc, not by Vite, so the specifier is a value: the bundle is
// resolved by the browser at run time, next to this file, and TypeScript is not
// asked to find a file that only exists in the pak.
const bundle = './panel.mjs';

/** One row of the live tab list. */
function rowFor(tab: Tab): HTMLLIElement {
  const row = document.createElement('li');
  row.className = tab.active ? 'tab tab-active' : 'tab';

  const index = document.createElement('span');
  index.className = 'tab-index';
  index.textContent = String(tab.index + 1);

  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = tab.title || tab.domain || 'Untitled';

  const domain = document.createElement('span');
  domain.className = 'tab-domain';
  domain.textContent = tab.domain;

  row.append(index, title, domain);
  return row;
}

async function showBrowser(): Promise<void> {
  if (gate) gate.hidden = true;
  if (seam) seam.hidden = false;

  let tabs: Tab[] = [];
  try {
    ({tabs} = await PageHandler.getRemote().getTabs());
  } catch (failure) {
    // The most likely failure is a missing binder registration: the page asked
    // for `hook.mojom.PageHandler` and nothing answered. Say so on the page
    // instead of leaving it on "Loading…" forever.
    if (status) {
      status.textContent = `No handler for the tab list: ${String(failure)}`;
    }
    return;
  }

  if (list) {
    list.replaceChildren(...tabs.map(rowFor));
  }
  if (status) {
    const active = tabs.find(tab => tab.active);
    const position = active ? `tab ${active.index + 1} of ${tabs.length}` : 'no active tab';
    status.textContent =
        `${tabs.length} tab${tabs.length === 1 ? '' : 's'} open, ${position}`;
  }

  // The dock mounts itself into `#dock` as the bundle loads, so the element has
  // to exist first; the gate never creates it, which is why a signed-out page
  // never runs the conversation surface at all.
  const dock = document.createElement('div');
  dock.className = 'panel';
  dock.id = 'dock';
  (seam ?? document.body).append(dock);
  await import(bundle);
}

/** What the card needs, loosely: it is React's business, not this file's. */
type CardProps = Record<string, unknown>;

async function showGate(view: SignInView): Promise<void> {
  if (seam) seam.hidden = true;
  if (!gate) return;
  gate.hidden = false;

  const remote = PageHandler.getRemote();
  const {mountSignIn} = (await import(bundle)) as {
    mountSignIn: (
      host: HTMLElement,
      props: CardProps,
    ) => {update: (next: CardProps) => void};
  };

  let busy = false;
  let shownState = view.state;

  const open = (url: string) => {
    // A chrome:// page may open an https tab; if the popup is refused, taking
    // this tab is the same instruction with one fewer window.
    if (!window.open(url, '_blank', 'noopener')) {
      window.location.href = url;
    }
  };

  function start(): void {
    busy = true;
    draw(view);
    void remote.startSignIn().then(reply => {
      busy = false;
      draw(reply.view, reply.error || undefined);
      watch();
    });
  }

  function cancel(): void {
    // `CancelSignIn` has no result: the app abandons the flow and the next status
    // read is what shows it. The wait covers the POST landing before that read.
    remote.cancelSignIn();
    window.setTimeout(
      () => void remote.getSignIn().then(({view}) => draw(view)),
      300);
  }

  function face(next: SignInView, error?: string): CardProps {
    const pending = next.state === 'pending';
    return {
      state: pending ? 'pending' : 'idle',
      code: next.userCode || undefined,
      busy,
      error: error || next.message || undefined,
      surface: false,
      kicker: pending ? 'Almost there' : 'Hook Browser',
      title: pending
        ? 'Approve Hook in your browser.'
        : 'Sign in to start browsing.',
      copy: next.available
        ? 'Signing in happens in the Hook app on this computer, and the browser '
          + 'reads the account it writes. Open the page, check that the code '
          + 'matches, and the web opens again by itself.'
        : 'Hook is not running on this computer, and the browser cannot sign in '
          + 'on its own: the account file belongs to the app. Start Hook, then '
          + 'come back to this tab.',
      signInLabel: next.available ? 'Sign in with Hook' : 'Sign in',
      hint: 'Waiting for the app to approve this browser. This tab finishes by '
        + 'itself.',
      onSignIn: start,
      onOpenPage: next.verificationUrl
        ? () => open(next.verificationUrl)
        : undefined,
      onCancel: pending ? cancel : undefined,
      alternate: next.available
        ? undefined
        : {label: 'Get Hook', onClick: () => open('https://hookcode.io')},
      // The browser never holds the credential: the app does. Saying "your
      // Google password never touches Hook" here would name a form this page
      // never shows.
      privacy:
        'The token stays with the Hook app. This page only reads whether the ' +
        'account exists, and asks the app to start the flow.', 
    };
  }

  function draw(next: SignInView, error?: string): void {
    shownState = next.state;
    card.update(face(next, error));
  }

  const card = mountSignIn(gate, face(view));

  // The app is the one that finishes the flow, so the page only watches: twice
  // a second while a code waits, slower while signed out, because "start Hook"
  // is the likeliest thing to change under this tab.
  let timer = 0;
  function watch(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void remote.getSignIn().then(({view: next}) => {
        if (next.signedIn) {
          window.location.reload();
          return;
        }
        if (next.state !== shownState) draw(next);
        watch();
      });
    }, shownState === 'pending' ? 2000 : 3000);
  }
  watch();
}

async function main(): Promise<void> {
  let view: SignInView;
  try {
    // A mojom struct return arrives boxed (`{view}`), which is what lets the
    // generator express a null one; ours is never null but the box is the shape.
    ({view} = await PageHandler.getRemote().getSignIn());
  } catch (failure) {
    // Without a handler there is no gate and no account: show the seam, which
    // is the Step 1 proof, and say what failed.
    if (status) {
      status.textContent = `No handler for the sign-in state: ${String(failure)}`;
    }
    if (seam) seam.hidden = false;
    return;
  }
  if (view.signedIn) {
    await showBrowser();
    return;
  }
  await showGate(view);
}

void main();
