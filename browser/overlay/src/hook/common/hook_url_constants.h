// Hook Browser: the one place our chrome:// host is named.
//
// Upstream's chrome/common/webui_url_constants.h is deliberately not patched:
// a host constant is not a registration list, and an overlay file costs
// nothing to rebase.

#ifndef HOOK_COMMON_HOOK_URL_CONSTANTS_H_
#define HOOK_COMMON_HOOK_URL_CONSTANTS_H_

namespace hook {

// chrome://hook
inline constexpr char kHookHost[] = "hook";

// The page itself, which is also where a signed-out navigation lands
// (hook_sign_in_throttle.cc) and where the browser opens at first run.
inline constexpr char kHookURL[] = "chrome://hook/";

// The dock as a side panel. A separate host from chrome://hook because the side
// panel hosts a *top chrome* WebUI, and the same page should not be both.
inline constexpr char kHookPanelHost[] = "hook-panel";
inline constexpr char kHookPanelURL[] = "chrome://hook-panel/";

}  // namespace hook

#endif  // HOOK_COMMON_HOOK_URL_CONSTANTS_H_
