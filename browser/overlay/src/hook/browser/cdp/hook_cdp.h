// Hook Browser: the DevTools protocol, for the agent.
//
// A page read gives a model words; everything else an agent needs to *do*
// something on a page — a trusted click, a key press, a screenshot, a form, a
// network request, an emulated phone — is behind the DevTools protocol, and the
// browser process is the only place it can be reached from.
//
// This is deliberately one seam and not a tool per capability. The command
// vocabulary lives in `crates/hook-core/src/browser.rs`, where a new capability
// is a Rust change and a release, not a Chromium rebuild and a patch stack
// entry. The contract is the protocol's own: a method name, its params, and its
// result object.
//
// It is not a remote-debugging port. Nothing listens: the browser process
// attaches to a tab it already owns, sends one command, and detaches.

#ifndef HOOK_BROWSER_CDP_HOOK_CDP_H_
#define HOOK_BROWSER_CDP_HOOK_CDP_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}  // namespace content

namespace hook {

// One protocol command's answer: the reply's `result` object, or why there is
// none. A protocol-level `error` frame is a refusal, not a crash: it arrives
// here with `ok` false and the browser's own sentence.
struct CdpReply {
  bool ok = false;
  std::string error;
  base::DictValue result;
};

// Sends `method` to `contents` and answers exactly once: the protocol reply, an
// attach failure, the tab closing, or a timeout.
//
// It attaches to the page target — the one a DevTools window inspects a tab
// through — because a tab target is browser-only: it carries `Target` and `IO`,
// and `Runtime.evaluate` there answers "method not found". The host is created
// and detached per command, so a navigation that replaces the frame is not a
// session this call has to keep alive.
void SendCdpCommand(content::WebContents* contents,
                    const std::string& method,
                    base::DictValue params,
                    base::OnceCallback<void(CdpReply)> done);

}  // namespace hook

#endif  // HOOK_BROWSER_CDP_HOOK_CDP_H_
