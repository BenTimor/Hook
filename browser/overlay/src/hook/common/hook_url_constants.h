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

}  // namespace hook

#endif  // HOOK_COMMON_HOOK_URL_CONSTANTS_H_
