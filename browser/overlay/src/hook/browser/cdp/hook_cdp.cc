// Hook Browser: one DevTools protocol command against one tab.

#include "hook/browser/cdp/hook_cdp.h"

#include <optional>
#include <string>
#include <utility>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace hook {
namespace {

// The host stops waiting for an answer after 50 seconds (`CDP_WAIT` in
// `crates/hook-core/src/browser.rs`) and the relay cuts an RPC at 60, so this
// gives up in between. A session left attached would keep the user's own DevTools
// from opening on that tab for the rest of the browser's life, which is worse
// than a slow call.
constexpr base::TimeDelta kTimeout = base::Seconds(60);

// Every command this client sends carries this id, and only the frame that has
// it is the answer: the protocol multiplexes events onto the same wire.
constexpr int kCommandId = 1;

std::string SayError(const base::DictValue& error) {
  const std::string* message = error.FindString("message");
  if (!message || message->empty()) {
    return "The browser refused that protocol call.";
  }
  return *message;
}

// One command, one client, one answer. Chrome keeps the client as a raw
// pointer for the life of the attach, so this object owns itself and is gone
// the moment it has answered.
class CdpSession : public content::DevToolsAgentHostClient {
 public:
  CdpSession(const std::string& method,
             base::DictValue params,
             base::OnceCallback<void(CdpReply)> done)
      : method_(method), params_(std::move(params)), done_(std::move(done)) {}

  CdpSession(const CdpSession&) = delete;
  CdpSession& operator=(const CdpSession&) = delete;

  void Start(content::WebContents* contents) {
    // The *page* target, not the tab one: a tab target is browser-only (it
    // carries Target and IO and nothing else), so `Runtime.evaluate` and the
    // page domains would answer "method not found". This is the same host the
    // DevTools window inspects a tab through.
    agent_host_ = content::DevToolsAgentHost::GetOrCreateFor(contents);
    if (!agent_host_) {
      Finish(Refused("That tab cannot be driven."));
      return;
    }
    // A tab has one debugger at a time. While the DevTools window is open on a
    // tab the agent gets a sentence instead of a call that never comes back.
    if (!agent_host_->AttachClient(this)) {
      Finish(Refused(
          "DevTools is attached to that tab. Close its DevTools window and try "
          "again."));
      return;
    }
    attached_ = true;
    timer_.Start(FROM_HERE, kTimeout,
                 base::BindOnce(&CdpSession::OnTimeout,
                                base::Unretained(this)));

    base::DictValue message;
    message.Set("id", kCommandId);
    message.Set("method", method_);
    if (!params_.empty()) {
      message.Set("params", std::move(params_));
    }
    const std::string json = base::WriteJson(message).value_or("{}");
    agent_host_->DispatchProtocolMessage(this, base::as_byte_span(json));
  }

  // content::DevToolsAgentHostClient:
  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override {
    if (!done_) {
      return;
    }
    const std::string text(reinterpret_cast<const char*>(message.data()),
                           message.size());
    std::optional<base::DictValue> frame =
        base::JSONReader::ReadDict(text, base::JSON_PARSE_RFC);
    if (!frame) {
      return;
    }
    std::optional<int> id = frame->FindInt("id");
    if (!id || *id != kCommandId) {
      return;  // an event, not the answer to this command
    }
    CdpReply reply;
    if (const base::DictValue* error = frame->FindDict("error")) {
      reply.ok = false;
      reply.error = SayError(*error);
    } else {
      // A command that has no result (`Page.enable`, an input event) answers
      // with an empty object, which is a successful call.
      reply.ok = true;
      if (const base::DictValue* result = frame->FindDict("result")) {
        reply.result = result->Clone();
      }
    }
    Finish(std::move(reply));
  }

  void AgentHostClosed(content::DevToolsAgentHost* agent_host) override {
    attached_ = false;
    Finish(Refused("That tab went away before the call finished."));
  }

  // The agent is the person at this browser. `run_js` is the point of the
  // feature, so the protocol's own policy questions are answered yes: reading a
  // local file the page may open, writing a download, and the unsafe operations
  // a script needs. The trust that matters is the one on the channel token, and
  // that is elsewhere.
  bool IsTrusted() override { return true; }
  bool MayAttachToURL(const GURL& url, bool is_webui) override { return true; }
  bool MayReadLocalFiles() override { return true; }
  bool MayWriteLocalFiles() override { return true; }
  bool AllowUnsafeOperations() override { return true; }
  std::string GetTypeForMetrics() override { return "Other"; }

 private:
  static CdpReply Refused(std::string error) {
    CdpReply reply;
    reply.ok = false;
    reply.error = std::move(error);
    return reply;
  }

  void OnTimeout() {
    Finish(Refused(
        "The page did not answer in time. A script that never finishes, or a "
        "navigation during the call, leaves a command like this unanswered."));
  }

  void Finish(CdpReply reply) {
    if (!done_) {
      return;
    }
    base::OnceCallback<void(CdpReply)> done = std::move(done_);
    timer_.Stop();
    // The answer goes first: the caller is waiting on it, and detaching cannot
    // change what happened.
    std::move(done).Run(std::move(reply));

    base::SequencedTaskRunner* runner =
        base::SequencedTaskRunner::GetCurrentDefault().get();
    if (attached_ && agent_host_) {
      attached_ = false;
      // Not inline: this runs from the protocol callback that answered the
      // command, and detaching tears down the session that callback is running
      // on. Posted first, so it runs before the delete below on the same
      // sequence.
      runner->PostTask(
          FROM_HERE,
          base::BindOnce(
              [](scoped_refptr<content::DevToolsAgentHost> host,
                 content::DevToolsAgentHostClient* client) {
                host->DetachClient(client);
              },
              std::move(agent_host_), this));
      agent_host_ = nullptr;
    }
    // Not `delete this`: Finish runs from the timer's own callback as well as
    // from the protocol's, and a timer deleted inside its callback is a
    // use-after-free the platform does not protect against.
    runner->DeleteSoon(FROM_HERE, this);
  }

  const std::string method_;
  base::DictValue params_;
  base::OnceCallback<void(CdpReply)> done_;
  scoped_refptr<content::DevToolsAgentHost> agent_host_;
  base::OneShotTimer timer_;
  bool attached_ = false;
};

}  // namespace

void SendCdpCommand(content::WebContents* contents,
                    const std::string& method,
                    base::DictValue params,
                    base::OnceCallback<void(CdpReply)> done) {
  if (!contents) {
    CdpReply reply;
    reply.error = "That tab is no longer open.";
    std::move(done).Run(std::move(reply));
    return;
  }
  // The session deletes itself once it has answered (see Finish).
  (new CdpSession(method, std::move(params), std::move(done)))->Start(contents);
}

}  // namespace hook
