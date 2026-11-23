// Hook Browser: chrome://hook.
//
// The point of this file is not its text. It proves the module and mojom
// pipelines together: TypeScript under browser/overlay/src/hook/resources is
// compiled, packed, served from chrome://hook, and can ask the browser process
// for live state. The list below is what the browser actually has open.
//
// Step 2 replaces it with the real surfaces (the dock and the sign-in card).

import {PageHandler} from './hook.mojom-webui.js';
import type {Tab} from './hook.mojom-webui.js';

const status = document.querySelector<HTMLParagraphElement>('#status');
const list = document.querySelector<HTMLOListElement>('#tabs');

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

async function main(): Promise<void> {
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
}

void main();
