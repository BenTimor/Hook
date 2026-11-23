// Hook Browser: the live tab list.
//
// Step 1 of docs/browser-poc-plan.md. It reads what the browser has open for the
// window that hosts a WebUI page, using BrowserWindowInterface (the interface
// //chrome/browser is meant to depend on) rather than any concrete Browser, so
// the overlay stays a leaf of the dependency graph instead of a cycle in it.
//
// Read-only on purpose: the POC gives the chat agent no browser tools, so
// nothing here mutates a tab.

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
  int index = 0;
  int id = 0;
  bool active = false;
  std::string title;
  std::string domain;
};

// The tabs open in the browser window that hosts `web_contents`. Empty when the
// WebContents is not a tab in a browser window (an app window, a test, a
// detached WebUI).
std::vector<HookTab> ReadTabs(const content::WebContents* web_contents);

}  // namespace hook

#endif  // HOOK_BROWSER_TABS_HOOK_TABS_H_
