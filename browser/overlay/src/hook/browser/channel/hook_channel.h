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
#include <set>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/values.h"
#include "hook/browser/channel/hook_descriptor.h"

class Profile;

namespace hook {

// One reply: the parsed body, or a sentence for the page.
using ChannelReply =
    base::OnceCallback<void(std::optional<base::DictValue> body,
                            const std::string& error)>;

// What a stream is, from the outside: an open request the browser moves around
// and destroys. Everything that knows about it being an HTTP response lives in
// the .cc.
class HookStream {
 public:
  HookStream() = default;
  HookStream(const HookStream&) = delete;
  HookStream& operator=(const HookStream&) = delete;
  virtual ~HookStream() = default;
};

// One `data:` line of the host's stream, as JSON.
using StreamFrame = base::RepeatingCallback<void(const std::string& frame)>;
// `` when the stream ended by itself, a sentence when it was cut off.
using StreamEnd = base::OnceCallback<void(const std::string& error)>;

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

  // A long-lived GET: one response the host keeps open and writes frames into.
  //
  // What the page needs from a turn is a sentence at a time, and asking for the
  // whole conversation three times a second was the old way to get it
  // (`/chats/<id>/events`, `stream_chat` in `crates/hook-core/src/channel.rs`).
  // The browser process holds the response and the page handler pushes each
  // frame over mojom, so the page never polls.
  //
  // `frame` gets the payload of every `data:` line; `end` runs once, with an
  // empty string when the stream finished and a sentence when it was cut off.
  // Destroying the returned object cancels the request, which is how a page
  // that has finished with the turn stops it.
  std::unique_ptr<HookStream> Open(const std::string& path,
                                   StreamFrame frame,
                                   StreamEnd end);

 private:
  // Loads the descriptors (cached for a few seconds) and then runs `ready`.
  void WithDescriptor(base::OnceClosure ready);
  void OnDescriptorsRead(base::OnceClosure ready,
                         std::vector<ChannelDescriptor> descriptors);

  // Points `port_`/`token_` at `descriptors_[candidate_]`. False when that one is
  // unusable, in which case `error_` says why.
  bool AdoptCandidate();

  void Probe(AvailableCallback done);
  void OnHealthReply(AvailableCallback done,
                     std::optional<base::DictValue> reply,
                     const std::string& error);

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
  // Every descriptor that exists, most preferred first, and the one requests go
  // to. A host that was killed leaves its file behind, so a dead entry is skipped
  // for the next product's rather than reported as "Hook is not running".
  std::vector<ChannelDescriptor> descriptors_;
  size_t candidate_ = 0;
  // Ports that refused a request. A killed host leaves its descriptor behind,
  // and the browser prefers its own: without this, every real request went to
  // the dead port while the live app's descriptor sat next in the list, and the
  // panel said "Hook is not listening" to someone looking at Hook. Only the
  // probe walked the list; now the requests do too. A port is forgotten as soon
  // as a health check on it succeeds.
  std::set<std::string> refused_;
  std::string port_;
  std::string token_;
  std::string error_;
  base::TimeTicks read_at_;

  base::WeakPtrFactory<HookChannel> weak_factory_{this};
};

}  // namespace hook

#endif  // HOOK_BROWSER_CHANNEL_HOOK_CHANNEL_H_
