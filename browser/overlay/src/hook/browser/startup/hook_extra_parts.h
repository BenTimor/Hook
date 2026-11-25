// Hook Browser: the one thing that has to happen at browser startup.
//
// A page read has to work while the side panel is closed — the browser merely
// has to be running — so the poller cannot be started by a page. This extra part
// starts it for every profile that exists when the browser comes up, which is
// the same seam Chrome's own startup work uses.

#ifndef HOOK_BROWSER_STARTUP_HOOK_EXTRA_PARTS_H_
#define HOOK_BROWSER_STARTUP_HOOK_EXTRA_PARTS_H_

#include "chrome/browser/chrome_browser_main_extra_parts.h"

namespace hook {

class HookExtraParts : public ChromeBrowserMainExtraParts {
 public:
  HookExtraParts();
  HookExtraParts(const HookExtraParts&) = delete;
  HookExtraParts& operator=(const HookExtraParts&) = delete;
  ~HookExtraParts() override;

  // ChromeBrowserMainExtraParts:
  void PostBrowserStart() override;
};

}  // namespace hook

#endif  // HOOK_BROWSER_STARTUP_HOOK_EXTRA_PARTS_H_
