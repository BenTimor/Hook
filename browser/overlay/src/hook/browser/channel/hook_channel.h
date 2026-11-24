// Hook Browser: the client for the Hook host's loopback channel.
//
// A `chrome://` renderer may not make this request itself — Chromium terminates
// the renderer for a cross-scheme URLLoader — so the browser process makes it and
// the page sees the answer over mojom. That is also why the token never reaches
// the page: it is read here, from the shared descriptor, and used here.
//
// Which process answers is not this file's business. A channel is published by
// whichever Hook process is running: the host this browser started itself
// (`browser/host/hook_host.h`, `hook-host`), or an app in the tray if it answers
// first. Each product publishes its own descriptor
// (`browser-channel.<product>.json`), and this browser reads its own first.
//
// The descriptor is read on a thread pool: the page asks for it as soon as it
// loads, which can be inside the browser's startup tasks, where the UI thread is
// not allowed to block on a file.
//
// The endpoint is `crates/hook-core/src/channel.rs`. When the sidecar from
// docs/browser-host.md exists, it publishes the same routes and this file does
// not change.

#ifndef HOOK_BROWSER_CHANNEL_HOOK_CHANNEL_H_
#define HOOK_BROWSER_CHANNEL_HOOK_CHANNEL_H_

#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/values.h"

class Profile;

namespace hook {

// One reply: the parsed body, or a sentence for the page.
using ChannelReply =
    base::OnceCallback<void(std::optional<base::DictValue> body,
                            const std::string& error)>;

class HookChannel {
 public:
  explicit HookChannel(Profile* profile);
  HookChannel(const HookChannel&) = delete;
  HookChannel& operator=(const HookChannel&) = delete;
  ~HookChannel();

  // Whether a Hook host is actually answering: the descriptor exists *and*
  // `/health` replies, so a descriptor left behind by a killed app reads as "not
  // running" instead of failing on the first real request. When nothing answers,
  // this also starts the browser's own host (`host::EnsureRunning`) unless a
  // switch turned that off; the answer is the same either way. Asynchronous,
  // because reading the descriptor may happen while the browser still forbids
  // blocking work, and because a host takes a second to publish its channel.
  using AvailableCallback =
      base::OnceCallback<void(bool available, const std::string& reason)>;
  void Check(AvailableCallback done);

  void Get(const std::string& path, ChannelReply done);
  void Post(const std::string& path, const base::DictValue& body,
            ChannelReply done);

 private:
  // Loads the descriptor (cached for a few seconds) and then runs `ready`.
  void WithDescriptor(base::OnceClosure ready);

  void Probe(AvailableCallback done);

  // `Check`'s two ways onward: nothing answered, so the host is started; and the
  // host is up, so the descriptor is read again (it is new) and probed again.
  void OnProbed(AvailableCallback done,
                bool available,
                const std::string& reason);
  void OnHostStarted(AvailableCallback done,
                     const std::string& reason,
                     bool started,
                     const std::string& host_reason);

  void SendRequest(const std::string& method,
                   const std::string& path,
                   const std::string& payload,
                   ChannelReply done);

  raw_ptr<Profile> profile_;
  std::string port_;
  std::string token_;
  std::string error_;
  base::TimeTicks read_at_;

  base::WeakPtrFactory<HookChannel> weak_factory_{this};
};

}  // namespace hook

#endif  // HOOK_BROWSER_CHANNEL_HOOK_CHANNEL_H_
