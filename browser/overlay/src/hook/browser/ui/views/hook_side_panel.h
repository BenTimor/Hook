// Hook Browser: the dock as a side panel entry.
//
// Step 2 of docs/browser-poc-plan.md. `RegisterHookSidePanel` adds the entry to
// a window's registry; the content is a `SidePanelWebUIViewT` over
// chrome://hook-panel, which is the same React bundle chrome://hook draws beside
// the seam page.
//
// It is registered from BrowserWindowFeatures (`browser/patches/`), the place
// every built-in side panel is created. Its toolbar button is an ordinary pinned
// action (`kActionSidePanelShowHookChat`), pinned by default in
// `toolbar_pref_names.cc` so the dock is one click away on a fresh profile;
// `--hook-side-panel` also opens it at startup, which is what a check can do
// without clicking.

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
