// Hook Browser: the browser's side of the page-read queue.
//
// A chat anywhere on the account can ask this machine for a tab: the dock's own
// conversation, Hook in another window, a phone. The request arrives on the
// loopback channel (`crates/hook-core/src/channel.rs`, the `browser/tasks`
// routes) and waits there; this class is what picks it up, reads the page in the
// browser process, and answers.
//
// It lives on the profile rather than on a page, because a read has to work when
// the side panel is closed — the browser merely has to be running. That is also
// why it starts at browser startup (hook/browser/startup/hook_extra_parts.h)
// instead of on the first `chrome://hook-panel` load.
//
// One channel per profile, shared with the page handler: the dock and the queue
// read the same descriptor and use the same token, and a host that restarts is
// picked up once for both.

#ifndef HOOK_BROWSER_SERVICE_HOOK_SERVICE_H_
#define HOOK_BROWSER_SERVICE_HOOK_SERVICE_H_

#include <memory>
#include <optional>
#include <string>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/supports_user_data.h"
#include "base/timer/timer.h"
#include "base/values.h"

class Profile;

namespace hook {

class HookChannel;

class BrowserService : public base::SupportsUserData::Data {
 public:
  // The service for `profile`, made on first use and owned by the profile.
  static BrowserService* For(Profile* profile);
  BrowserService(const BrowserService&) = delete;
  BrowserService& operator=(const BrowserService&) = delete;
  ~BrowserService() override;

  // The channel the page handler also uses.
  HookChannel* channel();

  // Begins polling for page work. Idempotent; called at browser startup and by
  // `channel()`, so a browser that missed the startup call still serves reads.
  void Start();

 private:
  explicit BrowserService(Profile* profile);

  void Poll();
  // The poll never came back: free the slot and try again.
  void Unstick();
  void OnPoll(std::optional<base::DictValue> body, const std::string& error);
  void RunTask(const base::DictValue& task);
  void Answer(const std::string& id, base::DictValue reply);
  void Schedule(base::TimeDelta delay);

  raw_ptr<Profile> profile_;
  std::unique_ptr<HookChannel> channel_;
  base::OneShotTimer timer_;
  base::OneShotTimer watchdog_;
  bool polling_ = false;
  bool started_ = false;
  // Consecutive polls with no host answering: a browser with no Hook running
  // should not knock every 200ms forever.
  int failures_ = 0;

  base::WeakPtrFactory<BrowserService> weak_factory_{this};
};

}  // namespace hook

#endif  // HOOK_BROWSER_SERVICE_HOOK_SERVICE_H_
