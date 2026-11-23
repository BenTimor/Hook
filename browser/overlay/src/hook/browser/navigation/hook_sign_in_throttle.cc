// Hook Browser: the sign-in gate.

#include "hook/browser/navigation/hook_sign_in_throttle.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/values.h"
#include "build/build_config.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/web_contents.h"
#include "hook/common/hook_url_constants.h"
#include "ui/base/page_transition_types.h"
#include "url/gurl.h"

namespace hook {
namespace {

// A switch, because the gate has to be provable on a machine whose account file
// has a live session: `--hook-signin-state=out` pretends there is none, `in`
// forces the other direction. Absent means "read the account file".
constexpr char kSignInStateSwitch[] = "hook-signin-state";

// The account file changes when a product signs in or out; a few seconds of
// staleness is cheaper than reading it on every navigation.
constexpr base::TimeDelta kCacheLifetime = base::Seconds(5);

constexpr char kAccountDirName[] = "app.hook";
constexpr char kAccountFileName[] = "account.json";

// The same directory `hook-core` writes: `app_data_dir().parent()` on Windows
// and macOS, and the XDG data home on Linux.
base::FilePath AccountFilePath() {
  base::FilePath dir;
#if BUILDFLAG(IS_WIN)
  if (!base::PathService::Get(base::DIR_ROAMING_APP_DATA, &dir)) {
    return base::FilePath();
  }
#elif BUILDFLAG(IS_MAC)
  if (!base::PathService::Get(base::DIR_APP_DATA, &dir)) {
    return base::FilePath();
  }
#else
  const char* data_home = getenv("XDG_DATA_HOME");
  if (data_home && *data_home) {
    dir = base::FilePath(data_home);
  } else if (!base::PathService::Get(base::DIR_HOME, &dir)) {
    return base::FilePath();
  } else {
    dir = dir.AppendASCII(".local").AppendASCII("share");
  }
#endif
  return dir.AppendASCII(kAccountDirName).AppendASCII(kAccountFileName);
}

// Runs on a thread pool: the read blocks, and a navigation can begin during
// startup, where the browser process disallows blocking work on the UI thread.
bool ReadAccountFile() {
  const base::FilePath path = AccountFilePath();
  if (path.empty()) {
    return false;
  }
  std::string raw;
  if (!base::ReadFileToString(path, &raw)) {
    // No account file is the signed-out case, not an error: a fresh machine has
    // never signed in.
    return false;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(raw, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return false;
  }
  // `session` is null after signing out, and `token` is what every product
  // presents. The value is deliberately not logged, copied or cached anywhere
  // but here.
  const base::DictValue* session = parsed->GetDict().FindDict("session");
  if (!session) {
    return false;
  }
  const std::string* token = session->FindString("token");
  return token && !token->empty();
}

// What the last read found, shared by every throttle on the UI thread. One read
// at a time: a burst of navigations after startup waits on the same task.
struct AccountState {
  std::optional<bool> signed_in;
  base::TimeTicks checked_at;
  bool reading = false;
  std::vector<base::OnceCallback<void(bool)>> waiters;

  bool IsFresh() const {
    return signed_in.has_value() && !checked_at.is_null() &&
           base::TimeTicks::Now() - checked_at < kCacheLifetime;
  }
};

AccountState& State() {
  // Process-lifetime, on purpose: no exit-time destructor, and every throttle
  // shares the one answer.
  static base::NoDestructor<AccountState> state;
  return *state;
}

void OnAccountRead(bool signed_in) {
  AccountState& state = State();
  state.signed_in = signed_in;
  state.checked_at = base::TimeTicks::Now();
  state.reading = false;
  std::vector<base::OnceCallback<void(bool)>> waiters = std::move(state.waiters);
  state.waiters.clear();
  for (auto& waiter : waiters) {
    std::move(waiter).Run(signed_in);
  }
}

void RequestAccountState(base::OnceCallback<void(bool)> done) {
  AccountState& state = State();
  if (state.IsFresh()) {
    std::move(done).Run(*state.signed_in);
    return;
  }
  state.waiters.push_back(std::move(done));
  if (state.reading) {
    return;
  }
  state.reading = true;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadAccountFile),
      base::BindOnce(&OnAccountRead));
}

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

  AccountState& state = State();
  if (state.IsFresh()) {
    if (*state.signed_in) {
      return PROCEED;
    }
    ShowSignInCard();
    return CANCEL_AND_IGNORE;
  }

  // The account file has not been read yet (or not recently): hold the
  // navigation until we know, rather than guessing in either direction.
  RequestAccountState(base::BindOnce(
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
