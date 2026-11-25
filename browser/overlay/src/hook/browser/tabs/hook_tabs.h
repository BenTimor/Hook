// Hook Browser: the live tab list.
//
// Step 1 of docs/browser-poc-plan.md. It reads what the browser has open, using
// BrowserWindowInterface (the interface //chrome/browser is meant to depend on)
// rather than any concrete Browser, so the overlay stays a leaf of the
// dependency graph instead of a cycle in it.
//
// Tabs are numbered **across windows**, from one, in window creation order. That
// is the number a person reading the strip would use, the number the context
// frame prints, and the number `read_page`/`find_in_page` take — one numbering
// everywhere, so the model never has to translate. The tab's *handle* is what
// the browser itself is keyed on, and it never leaves the browser process.
//
// Read-only on purpose. The chat agent reads a tab's text (`hook_page.h`), never
// its pixels or its form state, and nothing here mutates a tab.

#ifndef HOOK_BROWSER_TABS_HOOK_TABS_H_
#define HOOK_BROWSER_TABS_HOOK_TABS_H_

#include <string>
#include <vector>

namespace content {
class WebContents;
}  // namespace content

namespace hook {

// One row of the live tab list, in tabstrip order.
struct HookTab {
  /// Position in the strip, zero based, counted across every window.
  int index = 0;
  /// The tab's handle: stable for the life of the tab. Never shown to the model.
  int id = 0;
  /// Which window, from one. A page read names a tab, not a window; this is
  /// here so a person (and the model) can tell two strips apart.
  int window = 0;
  bool active = false;
  std::string title;
  std::string url;
  std::string domain;
};

// Every tab of every browser window, in window creation order.
std::vector<HookTab> ReadAllTabs();

// The tab numbered `number` (one based, as `ReadAllTabs` numbers them), or null
// when that tab has been closed since the list was read.
content::WebContents* FindTabByNumber(int number);

// The selected tab of the window that hosts `anchor` — what "this page" means
// to a message sent from that window's dock. Null when the window is gone.
content::WebContents* ActiveTabIn(const content::WebContents* anchor);

// The selected tab of the most recently active window, for work that has no
// anchor (a page read asked for by another machine).
content::WebContents* ActiveTab();

}  // namespace hook

#endif  // HOOK_BROWSER_TABS_HOOK_TABS_H_
