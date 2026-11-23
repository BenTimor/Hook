// Hook Browser: the sign-in gate.
//
// Step 1 of docs/browser-poc-plan.md, the last piece. Signed out means the
// browser *is* the sign-in card: a navigation to the web is cancelled and the
// tab is sent to chrome://hook. Internal schemes (chrome://, chrome-untrusted://,
// about:, file:) always load, so the card is reachable and the gate cannot loop.
//
// It only reads the shared account file. Signing in and out stays in `auth.rs`;
// a throttle that wrote the account would be a second writer, and the file is
// shared by every Hook product.

#ifndef HOOK_BROWSER_NAVIGATION_HOOK_SIGN_IN_THROTTLE_H_
#define HOOK_BROWSER_NAVIGATION_HOOK_SIGN_IN_THROTTLE_H_

#include <memory>

#include "base/memory/weak_ptr.h"
#include "content/public/browser/navigation_throttle.h"

namespace content {
class NavigationThrottleRegistry;
}  // namespace content

namespace hook {

class HookSignInThrottle : public content::NavigationThrottle {
 public:
  // The throttle, for a web navigation while signed out; nullptr otherwise.
  // Registered from chrome_content_browser_client_navigation_throttles.cc, which
  // is one of the patches in browser/patches/.
  static std::unique_ptr<content::NavigationThrottle> MaybeCreateThrottleFor(
      content::NavigationThrottleRegistry& registry);

  explicit HookSignInThrottle(content::NavigationThrottleRegistry& registry);
  HookSignInThrottle(const HookSignInThrottle&) = delete;
  HookSignInThrottle& operator=(const HookSignInThrottle&) = delete;
  ~HookSignInThrottle() override;

  // content::NavigationThrottle:
  const char* GetNameForLogging() override;
  ThrottleCheckResult WillStartRequest() override;
  ThrottleCheckResult WillRedirectRequest() override;

 private:
  ThrottleCheckResult Check();

  // The account file is read on a thread pool; a navigation that arrives before
  // the first read is deferred until this runs.
  void OnAccountStateKnown(bool signed_in);

  // Sends the tab that asked for the web to chrome://hook.
  void ShowSignInCard();

  base::WeakPtrFactory<HookSignInThrottle> weak_factory_{this};
};

}  // namespace hook

#endif  // HOOK_BROWSER_NAVIGATION_HOOK_SIGN_IN_THROTTLE_H_
