// Hook Browser: the dock as a side panel entry.
//
// Step 2 of docs/browser-poc-plan.md. `RegisterHookSidePanel` adds the entry to
// a window's registry; the content is a `SidePanelWebUIViewT` over
// chrome://hook-panel, which is the same React bundle chrome://hook draws beside
// the seam page.
//
// It is registered from BrowserWindowFeatures (`browser/patches/`), the place
// every built-in side panel is created, and it has no action id yet: nothing in
// the toolbar can open it, so `--hook-side-panel` opens it at startup until a
// product decision says where the button goes.

#ifndef HOOK_BROWSER_UI_VIEWS_HOOK_SIDE_PANEL_H_
#define HOOK_BROWSER_UI_VIEWS_HOOK_SIDE_PANEL_H_

class BrowserWindowInterface;
class Profile;

namespace hook {

// Adds the dock's entry to `browser`'s side panel. Idempotent per window: a
// registry refuses a duplicate key.
void RegisterHookSidePanel(BrowserWindowInterface* browser, Profile* profile);

}  // namespace hook

#endif  // HOOK_BROWSER_UI_VIEWS_HOOK_SIDE_PANEL_H_
