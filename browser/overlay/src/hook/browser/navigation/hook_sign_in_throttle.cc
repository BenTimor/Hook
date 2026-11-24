// Hook Browser: the sign-in gate.

#include "hook/browser/navigation/hook_sign_in_throttle.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/task/sequenced_task_runner.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "hook/browser/account/hook_account.h"
#include "hook/common/hook_url_constants.h"
#include "ui/base/page_transition_types.h"
#include "url/gurl.h"

namespace hook {
namespace {

using account::kSignInStateSwitch;

// The web is what the sign-in card stands in front of. Internal schemes are
// what the card itself and the browser's own surfaces need.
bool ShouldGate(const GURL& url) {
  return url.SchemeIsHTTPOrHTTPS();
}

}  // namespace

HookSignInThrottle::HookSignInThrottle(
    content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

HookSignInThrottle::~HookSignInThrottle() = default;

// static
std::unique_ptr<content::NavigationThrottle>
HookSignInThrottle::MaybeCreateThrottleFor(
    content::NavigationThrottleRegistry& registry) {
  content::NavigationHandle& handle = registry.GetNavigationHandle();
  if (!handle.IsInMainFrame() || handle.IsSameDocument()) {
    return nullptr;
  }
  if (!ShouldGate(handle.GetURL())) {
    return nullptr;
  }
  // `in` is the only state that can be decided without the account file, and it
  // is a test seam; everything else decides in Check(), which may defer.
  if (base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII(
          kSignInStateSwitch) == "in") {
    return nullptr;
  }
  return std::make_unique<HookSignInThrottle>(registry);
}

const char* HookSignInThrottle::GetNameForLogging() {
  return "HookSignInThrottle";
}

content::NavigationThrottle::ThrottleCheckResult
HookSignInThrottle::WillStartRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult
HookSignInThrottle::WillRedirectRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult HookSignInThrottle::Check() {
  content::NavigationHandle* handle = navigation_handle();
  if (!handle || !handle->IsInMainFrame() || handle->IsSameDocument()) {
    return PROCEED;
  }
  if (!ShouldGate(handle->GetURL())) {
    return PROCEED;
  }

  const std::string forced =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII(
          kSignInStateSwitch);
  if (forced == "in") {
    return PROCEED;
  }
  if (forced == "out") {
    ShowSignInCard();
    return CANCEL_AND_IGNORE;
  }

  // The account file has not been read yet (or not recently): hold the
  // navigation until we know, rather than guessing in either direction.
  account::RequestSignedIn(base::BindOnce(
      &HookSignInThrottle::OnAccountStateKnown, weak_factory_.GetWeakPtr()));
  return DEFER;
}

void HookSignInThrottle::OnAccountStateKnown(bool signed_in) {
  if (signed_in) {
    Resume();
    return;
  }
  ShowSignInCard();
  CancelDeferredNavigation(CANCEL_AND_IGNORE);
}

void HookSignInThrottle::ShowSignInCard() {
  content::NavigationHandle* handle = navigation_handle();
  if (!handle) {
    return;
  }
  content::WebContents* contents = handle->GetWebContents();
  if (!contents) {
    return;
  }
  // Cancel first, navigate second: starting a navigation from inside a
  // throttle callback re-enters the machinery that is running.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<content::WebContents> contents) {
            if (!contents) {
              return;
            }
            contents->GetController().LoadURL(
                GURL(kHookURL), content::Referrer(),
                ui::PAGE_TRANSITION_AUTO_TOPLEVEL, std::string());
          },
          contents->GetWeakPtr()));
}

}  // namespace hook
