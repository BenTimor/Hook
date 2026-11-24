// Hook Browser: starting the Hook host this browser talks to.
//
// `docs/browser-host.md`, "Starting it". The channel behind the dock and the
// sign-in card belongs to a *running* Hook process; when no channel answers, the
// browser starts one itself — once per browser run, from a path fixed at build
// time, and only after the descriptor it writes names our child. Nothing a page,
// a preference or an environment variable says can name an executable here.
//
// The process it starts is today's interim host: the chat app with no window and
// no tray icon (`--headless`, `crates/hook-core/src/lib.rs`). The sidecar in
// `docs/browser-host.md` replaces the binary, not this file.

#ifndef HOOK_BROWSER_HOST_HOOK_HOST_H_
#define HOOK_BROWSER_HOST_HOOK_HOST_H_

#include <string>

#include "base/functional/callback.h"

namespace hook::host {

// `--hook-no-host` is "never start anything": what a machine that runs Hook by
// hand, or a check that must not leave a process behind, passes.
inline constexpr char kNoHostSwitch[] = "hook-no-host";

// Whether this browser may start a host at all. False under `--hook-no-host` and
// under `--hook-signin-state` in either direction, which is a test seam and not a
// reason to spawn a process.
bool LaunchingAllowed();

// `started` is true only when the descriptor that appeared names the child we
// launched, so a host another product started is never mistaken for ours.
using StartedCallback =
    base::OnceCallback<void(bool started, const std::string& reason)>;

// Starts the host unless this browser already tried, then answers once it
// published its channel. Coalesced: a caller that arrives while a launch is in
// flight shares the attempt and its answer. The answer is remembered, so a second
// caller costs nothing and no launch loop is possible — except that a host this
// browser started and has since exited is treated as "nothing tried yet", or a
// closed host would need a browser restart to come back.
void EnsureRunning(StartedCallback done);

}  // namespace hook::host

#endif  // HOOK_BROWSER_HOST_HOOK_HOST_H_
