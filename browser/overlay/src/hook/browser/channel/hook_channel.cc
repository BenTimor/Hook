// Hook Browser: the client for the Hook host's loopback channel.

#include "hook/browser/channel/hook_channel.h"

#include <memory>
#include <optional>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_split.h"
#include "base/strings/stringprintf.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/task_traits.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include <vector>

#include "hook/browser/channel/hook_descriptor.h"
#include "hook/browser/host/hook_host.h"
#include "net/base/net_errors.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/cpp/simple_url_loader_stream_consumer.h"
#include "services/network/public/mojom/fetch_api.mojom-shared.h"
#include "url/gurl.h"

namespace hook {
namespace {

// Long enough that a page which asks for the channel, the chat list and one
// conversation reads the descriptor once; short enough that a host started or
// quit elsewhere is noticed without a reload.
constexpr base::TimeDelta kDescriptorLifetime = base::Seconds(5);
// SimpleURLLoader refuses a larger bound (`kMaxBoundedStringDownloadSize`).
constexpr size_t kMaxReplyBytes =
    network::SimpleURLLoader::kMaxBoundedStringDownloadSize;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("hook_browser_channel", R"(
        semantics {
          sender: "Hook Browser"
          description:
            "Reads the chat list and a conversation from the Hook host on this "
            "computer, and sends a message to it. The request goes to 127.0.0.1 "
            "only. The host is a Hook process on this machine: the app if it is "
            "running, or the one this browser started."
          trigger: "The user opens the Hook chat panel in Hook Browser."
          data:
            "The conversation id, the text the user typed, and the title of the "
            "page they are looking at."
          destination: LOCAL
        }
        policy {
          cookies_allowed: NO
          setting:
            "The channel exists while a Hook host is running; quitting it "
            "removes it."
          policy_exception_justification:
            "Loopback only. Nothing about this request leaves the machine."
        })");

}  // namespace

HookChannel::HookChannel(Profile* profile) : profile_(profile) {}

HookChannel::~HookChannel() = default;

void HookChannel::Check(AvailableCallback done) {
  WithDescriptor(base::BindOnce(
      &HookChannel::Probe, weak_factory_.GetWeakPtr(),
      base::BindOnce(&HookChannel::OnProbed, weak_factory_.GetWeakPtr(),
                     std::move(done))));
}

void HookChannel::Probe(AvailableCallback done) {
  if (port_.empty()) {
    std::move(done).Run(false, error_);
    return;
  }
  // The descriptor can outlive the app that wrote it (a killed process never
  // removes it), so ask before saying yes.
  SendRequest("GET", "/health", std::string(),
              base::BindOnce(&HookChannel::OnHealthReply,
                             weak_factory_.GetWeakPtr(), std::move(done)));
}

void HookChannel::OnHealthReply(AvailableCallback done,
                                std::optional<base::DictValue> reply,
                                const std::string& error) {
  if (reply) {
    refused_.erase(port_);
    std::move(done).Run(true, error);
    return;
  }
  // Nothing answered here. Every product writes its own descriptor beside the
  // account, and a browser whose own host was killed while the app is in the tray
  // has to read the app's — the first file that *exists* is not the one to use.
  while (++candidate_ < descriptors_.size()) {
    if (AdoptCandidate()) {
      Probe(std::move(done));
      return;
    }
  }
  std::move(done).Run(false, error_);
}

void HookChannel::OnProbed(AvailableCallback done,
                           bool available,
                           const std::string& reason) {
  if (available || !host::LaunchingAllowed()) {
    std::move(done).Run(available, reason);
    return;
  }
  // Nothing answers: start the host this browser is meant to talk to
  // (docs/browser-host.md, "Starting it"). The launcher is process-wide and
  // remembers its attempt, so two pages asking at once share one child and no
  // launch loop is possible.
  host::EnsureRunning(base::BindOnce(&HookChannel::OnHostStarted,
                                     weak_factory_.GetWeakPtr(),
                                     std::move(done), reason));
}

void HookChannel::OnHostStarted(AvailableCallback done,
                                const std::string& reason,
                                bool started,
                                const std::string& host_reason) {
  if (!started) {
    std::move(done).Run(false, host_reason.empty() ? reason : host_reason);
    return;
  }
  // The descriptor is new, so the cached read predates it by definition.
  read_at_ = base::TimeTicks();
  WithDescriptor(base::BindOnce(&HookChannel::Probe,
                                weak_factory_.GetWeakPtr(), std::move(done)));
}

void HookChannel::WithDescriptor(base::OnceClosure ready) {
  const base::TimeTicks now = base::TimeTicks::Now();
  if (!read_at_.is_null() && now - read_at_ < kDescriptorLifetime) {
    std::move(ready).Run();
    return;
  }
  read_at_ = now;

  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadChannelDescriptors),
      base::BindOnce(&HookChannel::OnDescriptorsRead,
                     weak_factory_.GetWeakPtr(), std::move(ready)));
}

void HookChannel::OnDescriptorsRead(
    base::OnceClosure ready,
    std::vector<ChannelDescriptor> descriptors) {
  descriptors_ = std::move(descriptors);
  candidate_ = 0;
  if (descriptors_.empty()) {
    port_.clear();
    token_.clear();
    error_ = "No Hook is running on this computer.";
  } else if (!AdoptCandidate() && !refused_.empty()) {
    // Every file we know about refused once. That is a stale memory, not a dead
    // machine: forget it and let the probe decide afresh.
    refused_.clear();
    candidate_ = 0;
    AdoptCandidate();
  }
  std::move(ready).Run();
}

bool HookChannel::AdoptCandidate() {
  port_.clear();
  token_.clear();
  error_.clear();
  while (candidate_ < descriptors_.size()) {
    const ChannelDescriptor& descriptor = descriptors_[candidate_];
    if (!descriptor.usable()) {
      error_ = descriptor.error;
      return false;
    }
    // Skip a port that refused us: a killed host's file outlives the process,
    // and the browser prefers its own descriptor over a running app's.
    if (refused_.find(descriptor.port) != refused_.end()) {
      ++candidate_;
      continue;
    }
    port_ = descriptor.port;
    token_ = descriptor.token;
    return true;
  }
  return false;
}

void HookChannel::Get(const std::string& path, ChannelReply done) {
  WithDescriptor(base::BindOnce(&HookChannel::SendRequest,
                                weak_factory_.GetWeakPtr(), "GET", path,
                                std::string(), std::move(done)));
}

void HookChannel::Post(const std::string& path,
                       const base::DictValue& body,
                       ChannelReply done) {
  WithDescriptor(base::BindOnce(
      &HookChannel::SendRequest, weak_factory_.GetWeakPtr(), "POST", path,
      base::WriteJson(body).value_or("{}"), std::move(done)));
}

void HookChannel::SendRequest(const std::string& method,
                              const std::string& path,
                              const std::string& payload,
                              ChannelReply done) {
  if (port_.empty()) {
    std::move(done).Run(std::nullopt, error_);
    return;
  }

  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GURL(
      base::StringPrintf("http://127.0.0.1:%s%s", port_.c_str(), path.c_str()));
  request->method = method;
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->headers.SetHeader("Authorization", "Bearer " + token_);

  auto loader =
      network::SimpleURLLoader::Create(std::move(request), kTrafficAnnotation);
  loader->SetTimeoutDuration(base::Seconds(30));
  // A refusal is a sentence from the app; keep the body of a 4xx.
  loader->SetAllowHttpErrorResults(true);
  if (method == "POST") {
    loader->AttachStringForUpload(payload, "application/json");
  }
  network::SimpleURLLoader* raw = loader.get();
  raw->DownloadToString(
      profile_->GetURLLoaderFactory().get(),
      base::BindOnce(
          [](base::WeakPtr<HookChannel> self, ChannelReply done,
             std::unique_ptr<network::SimpleURLLoader> keep_alive,
             std::optional<std::string> reply) {
            // `keep_alive` is the loader, alive until this runs.
            if (!reply.has_value()) {
              // Nothing answered on the port we adopted. The descriptor that
              // named it may be stale (a host killed hard cannot remove its file)
              // or the host may have restarted on a new port. The port is marked
              // refused so the next call picks the next descriptor — a live app
              // behind a dead browser-host file is the case that made the panel
              // say "Hook is not listening" — and the cache is invalidated so
              // that happens on the very next call.
              if (self) {
                self->refused_.insert(self->port_);
                self->read_at_ = base::TimeTicks();
              }
              std::move(done).Run(
                  std::nullopt, keep_alive->NetError() == net::OK
                                    ? "Hook did not answer."
                                    : "Hook is not listening on this computer.");
              return;
            }
            std::optional<base::Value> parsed =
                base::JSONReader::Read(*reply, base::JSON_PARSE_RFC);
            if (!parsed || !parsed->is_dict()) {
              std::move(done).Run(std::nullopt,
                                  "Hook answered something unexpected.");
              return;
            }
            base::DictValue body = std::move(*parsed).TakeDict();
            if (body.FindBool("ok") != true) {
              const std::string* error = body.FindString("error");
              std::move(done).Run(
                  std::nullopt,
                  error ? *error : std::string("Hook refused the request."));
              return;
            }
            std::move(done).Run(std::move(body), std::string());
          },
          weak_factory_.GetWeakPtr(), std::move(done), std::move(loader)),
      kMaxReplyBytes);
}

namespace {

// The stream as the browser holds it: a SimpleURLLoader that is never allowed to
// finish buffering, and the parser in front of it.
//
// Two rules keep this alive. `resume` is called synchronously — the page takes a
// frame as fast as the host writes one, and withholding it would turn the host's
// own flow control into a stalled turn. And the end callback is *posted*, never
// run inside `OnComplete`: it destroys this object (the page handler's last owner
// of a stream is the stream it was called for), and a consumer may not be deleted
// before `OnComplete` returns.
class ChannelStream final : public HookStream,
                            public network::SimpleURLLoaderStreamConsumer {
 public:
  ChannelStream(StreamFrame frame, StreamEnd end)
      : frame_(std::move(frame)), end_(std::move(end)) {}

  base::WeakPtr<ChannelStream> AsWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

  void Start(scoped_refptr<network::SharedURLLoaderFactory> factory,
             const std::string& url,
             const std::string& token) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL(url);
    request->method = "GET";
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->headers.SetHeader("Authorization", "Bearer " + token);
    request->headers.SetHeader("Accept", "text/event-stream");

    loader_ =
        network::SimpleURLLoader::Create(std::move(request), kTrafficAnnotation);
    // A turn can sit on a question for minutes. This is the page's connection to
    // it, not a request that should time out underneath it.
    loader_->SetTimeoutDuration(base::Minutes(20));
    loader_->SetAllowHttpErrorResults(true);
    loader_->DownloadAsStream(factory.get(), this);
  }

  // Ends the stream with a sentence. Safe to call once.
  void Fail(std::string error) {
    if (!end_) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(end_), std::move(error)));
  }

  // network::SimpleURLLoaderStreamConsumer:
  void OnDataReceived(std::string_view chunk,
                      base::OnceClosure resume) override {
    buffered_.append(chunk);
    size_t at = 0;
    // A blank line ends a frame; a partial one stays in the buffer until the
    // rest of it arrives.
    while ((at = buffered_.find("\n\n")) != std::string::npos) {
      const std::string block = buffered_.substr(0, at);
      buffered_.erase(0, at + 2);
      for (const auto& line :
           base::SplitStringPiece(block, "\n", base::TRIM_WHITESPACE,
                                  base::SPLIT_WANT_NONEMPTY)) {
        // `event:` names the frame and a line starting with ':' is a keep-alive;
        // the payload is the JSON, and the page reads its own `kind` from that.
        constexpr std::string_view kData = "data:";
        if (line.rfind(kData, 0) == 0) {
          frame_.Run(std::string(line.substr(kData.size())));
        }
      }
    }
    std::move(resume).Run();
  }

  void OnComplete(bool success) override {
    Fail(success ? std::string() : std::string("Hook stopped sending."));
  }

  // Retries are not enabled on this loader, so this never runs; it is pure
  // virtual in the interface and must still exist.
  void OnRetry(base::OnceClosure start_retry) override {
    std::move(start_retry).Run();
  }

 private:
  std::unique_ptr<network::SimpleURLLoader> loader_;
  std::string buffered_;
  StreamFrame frame_;
  StreamEnd end_;
  base::WeakPtrFactory<ChannelStream> weak_factory_{this};
};

}  // namespace

std::unique_ptr<HookStream> HookChannel::Open(const std::string& path,
                                              StreamFrame frame,
                                              StreamEnd end) {
  auto stream =
      std::make_unique<ChannelStream>(std::move(frame), std::move(end));
  base::WeakPtr<ChannelStream> weak = stream->AsWeakPtr();
  WithDescriptor(base::BindOnce(
      [](base::WeakPtr<HookChannel> self, base::WeakPtr<ChannelStream> weak,
         const std::string& path) {
        // The page dropped the observer while the descriptor was being read.
        if (!weak) {
          return;
        }
        if (!self || self->port_.empty()) {
          weak->Fail(self ? self->error_ : std::string("No Hook is running."));
          return;
        }
        weak->Start(self->profile_->GetURLLoaderFactory(),
                    base::StringPrintf("http://127.0.0.1:%s%s",
                                       self->port_.c_str(), path.c_str()),
                    self->token_);
      },
      weak_factory_.GetWeakPtr(), weak, path));
  return stream;
}

}  // namespace hook
