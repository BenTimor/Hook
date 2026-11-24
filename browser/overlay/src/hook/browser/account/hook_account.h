// Hook Browser: the shared account file, read once.
//
// Two places need the same answer — the navigation gate, which decides whether a
// page may load at all, and chrome://hook, which decides whether to draw the
// sign-in card — and the answer costs a file read. This is that read, and the
// short-lived cache in front of it, so the two cannot disagree inside one
// navigation.
//
// The session token is checked for existence and nothing else: it is never
// copied into a return value, logged, or handed to a page.

#ifndef HOOK_BROWSER_ACCOUNT_HOOK_ACCOUNT_H_
#define HOOK_BROWSER_ACCOUNT_HOOK_ACCOUNT_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"

namespace hook::account {

// A switch, because the gate has to be provable on a machine whose account file
// has a live session: `--hook-signin-state=out` pretends there is none, `in`
// forces the other direction. Absent means "read the account file". Both the
// navigation gate and the page's card read it, so they cannot disagree.
inline constexpr char kSignInStateSwitch[] = "hook-signin-state";

// The parts of `account.json` a face may see: who is signed in.
struct Identity {
  std::string email;
  std::string name;
};

// Whether `account.json` holds a session with a non-empty token. Blocking:
// thread pool only.
bool ReadSignedIn();

// The cached answer, if one is still fresh; `nullopt` when it would cost a read.
// The navigation gate asks this first so it can answer inside a throttle callback:
// `RequestSignedIn` runs its callback *inline* for a fresh cache, and resuming a
// navigation from there is a CHECK, because the registry has not recorded the
// deferral yet (`navigation_throttle_registry_impl.cc`,
// `ResumeProcessingNavigationEvent`). `RequestSignedIn` is for the other case,
// where the answer always arrives on a later task.
std::optional<bool> SignedInIfKnown();

// `ReadSignedIn()` with a few seconds of caching, callable from the UI thread.
// A burst of callers waits on one read; `force` re-reads now, which is what
// "sign out" and "signed in, look again" need.
void RequestSignedIn(base::OnceCallback<void(bool)> done, bool force = false);

// The signed-in account's display identity. Blocking: thread pool only. Empty
// when signed out or unreadable.
Identity ReadIdentity();

// Forgets the cached answer, so the next `RequestSignedIn` reads the file. The
// page calls this when it has just watched the app add a session.
void Forget();

}  // namespace hook::account

#endif  // HOOK_BROWSER_ACCOUNT_HOOK_ACCOUNT_H_
