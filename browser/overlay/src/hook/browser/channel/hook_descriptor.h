// Hook Browser: the descriptor a running Hook host publishes.
//
// `crates/hook-core/src/channel.rs` binds a loopback port, writes `port`, `token`
// and `pid` beside the shared account file, and removes the file on a clean quit.
// A killed process leaves it behind, so neither this file nor a caller may read
// "the file is there" as "someone is listening": the pid says whose descriptor it
// is, and `/health` says whether it answers.
//
// Reading is blocking, and both callers run it on a thread pool: the page asks for
// the channel as soon as it loads, which can be inside the browser's startup tasks
// where the UI thread may not touch a file, and the host launcher polls this file
// while a child boots.

#ifndef HOOK_BROWSER_CHANNEL_HOOK_DESCRIPTOR_H_
#define HOOK_BROWSER_CHANNEL_HOOK_DESCRIPTOR_H_

#include <string>
#include <vector>

namespace hook {

struct ChannelDescriptor {
  std::string port;
  std::string token;
  // The host process that wrote it; 0 when the file carries no pid.
  int pid = 0;

  // Nothing at all was published: no host has started here, or the one that did
  // has quit and cleaned up.
  bool missing = false;
  // A sentence for the page when the file exists and cannot be used. Empty when
  // `port` and `token` are set.
  std::string error;

  bool usable() const { return !port.empty() && !token.empty(); }
};

// Blocking. Never call this on the UI thread.
//
// Every descriptor that exists, in the order the browser prefers them: its own
// first, then the other products, then the single name every build before the
// split wrote. Empty when none exists. A host that was killed leaves its file
// behind and a *dead* one must not shadow a live one, so the caller tries them in
// order rather than taking the first that exists.
std::vector<ChannelDescriptor> ReadChannelDescriptors();

// The first of those, for the host launcher's pid poll — it only cares whether the
// browser's own descriptor names its child.
ChannelDescriptor ReadChannelDescriptor();

}  // namespace hook

#endif  // HOOK_BROWSER_CHANNEL_HOOK_DESCRIPTOR_H_
