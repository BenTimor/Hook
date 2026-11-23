// Hook Browser: the client for the running Hook app's loopback channel.

#include "hook/browser/channel/hook_channel.h"

#include <memory>
#include <optional>
#include <utility>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/task/task_traits.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "hook/browser/account/hook_paths.h"
#include "net/base/net_errors.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/fetch_api.mojom-shared.h"
#include "url/gurl.h"

namespace hook {
namespace {

constexpr base::TimeDelta kDescriptorLifetime = base::Seconds(5);
// SimpleURLLoader refuses a larger bound (`kMaxBoundedStringDownloadSize`).
constexpr size_t kMaxReplyBytes =
    network::SimpleURLLoader::kMaxBoundedStringDownloadSize;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("hook_browser_channel", R"(
        semantics {
          sender: "Hook Browser"
          description:
            "Reads the chat list and a conversation from a running Hook app on "
            "this computer, and sends a message to it. The request goes to "
            "127.0.0.1 only."
          trigger: "The user opens the Hook chat panel in Hook Browser."
          data:
            "The conversation id, the text the user typed, and the title of the "
            "page they are looking at."
          destination: LOCAL
        }
        policy {
          cookies_allowed: NO
          setting:
            "The channel exists while the Hook app is running; quitting Hook "
            "removes it."
          policy_exception_justification:
            "Loopback only. Nothing about this request leaves the machine."
        })");

struct Descriptor {
  std::string port;
  std::string token;
  std::string error;
};

// Runs on a thread pool: the page asks for the channel as soon as it loads, which
// can be inside the browser's startup tasks, where the UI thread is not allowed to
// touch a file.
Descriptor ReadDescriptor() {
  Descriptor descriptor;
  const base::FilePath path = paths::ChannelDescriptorFile();
  if (path.empty()) {
    descriptor.error = "Hook's data folder is not available on this computer.";
    return descriptor;
  }
  std::string raw;
  if (!base::ReadFileToString(path, &raw)) {
    descriptor.error = "Start Hook on this computer to use your chats.";
    return descriptor;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(raw, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    descriptor.error = "Hook published a channel this browser cannot read.";
    return descriptor;
  }
  const base::DictValue& dict = parsed->GetDict();
  const std::string* token = dict.FindString("token");
  const std::optional<int> port = dict.FindInt("port");
  if (!token || token->empty() || !port.has_value() || *port <= 0) {
    descriptor.error = "Hook published a channel this browser cannot read.";
    return descriptor;
  }
  descriptor.port = base::NumberToString(*port);
  descriptor.token = *token;
  return descriptor;
}

}  // namespace

HookChannel::HookChannel(Profile* profile) : profile_(profile) {}

HookChannel::~HookChannel() = default;

void HookChannel::Check(AvailableCallback done) {
  WithDescriptor(base::BindOnce(&HookChannel::Probe,
                                weak_factory_.GetWeakPtr(), std::move(done)));
}

void HookChannel::Probe(AvailableCallback done) {
  if (port_.empty()) {
    std::move(done).Run(false, error_);
    return;
  }
  // The descriptor can outlive the app that wrote it (a killed process never
  // removes it), so ask before saying yes.
  SendRequest("GET", "/health", std::string(),
              base::BindOnce(
                  [](AvailableCallback done,
                     std::optional<base::DictValue> reply,
                     const std::string& error) {
                    if (!reply) {
                      std::move(done).Run(
                          false,
                          "Start Hook on this computer to use your chats.");
                      return;
                    }
                    std::move(done).Run(true, error);
                  },
                  std::move(done)));
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
      base::BindOnce(&ReadDescriptor),
      base::BindOnce(
          [](base::WeakPtr<HookChannel> self, base::OnceClosure ready,
             Descriptor descriptor) {
            if (!self) {
              return;
            }
            self->port_ = std::move(descriptor.port);
            self->token_ = std::move(descriptor.token);
            self->error_ = std::move(descriptor.error);
            std::move(ready).Run();
          },
          weak_factory_.GetWeakPtr(), std::move(ready)));
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
          [](ChannelReply done,
             std::unique_ptr<network::SimpleURLLoader> keep_alive,
             std::optional<std::string> reply) {
            // `keep_alive` is the loader, alive until this runs.
            if (!reply.has_value()) {
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
          std::move(done), std::move(loader)),
      kMaxReplyBytes);
}

}  // namespace hook
