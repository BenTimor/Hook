// Hook Browser: the page handler both chrome://hook and chrome://hook-panel
// answer with.

#include "hook/browser/ui/webui/hook_page_handler.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/profiles/profile.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "hook/browser/account/hook_account.h"
#include "hook/browser/service/hook_service.h"
#include "hook/browser/tabs/hook_page.h"
#include "hook/browser/tabs/hook_tabs.h"
#include "hook/common/hook.mojom.h"

namespace hook {

// One page's view of one running turn.
struct HookPageHandler::Observation {
  int id = 0;
  mojo::Remote<mojom::ChatObserver> observer;
  std::unique_ptr<HookStream> stream;
};

namespace {

mojom::ChatSummaryPtr ToSummary(const base::DictValue& row) {
  mojom::ChatSummaryPtr summary = mojom::ChatSummary::New();
  if (const std::string* id = row.FindString("id")) {
    summary->id = *id;
  }
  if (const std::string* title = row.FindString("title")) {
    summary->title = *title;
  }
  // Rust writes milliseconds as an integer, so accept both number kinds.
  if (std::optional<double> seconds = row.FindDouble("updatedAt")) {
    summary->updated_at = *seconds;
  } else if (std::optional<int> millis = row.FindInt("updatedAt")) {
    summary->updated_at = *millis;
  }
  summary->busy = row.FindBool("busy").value_or(false);
  summary->unsynced = row.FindBool("unsynced").value_or(false);
  return summary;
}

}

// One sign-in lookup: the view being filled and the page waiting for it. Shared
// because every step is a separate asynchronous answer.
struct SignInLookup {
  mojom::SignInViewPtr view = mojom::SignInView::New();
  HookPageHandler::GetSignInCallback done;
};

namespace {

void FinishSignIn(SignInLookup& lookup) {
  std::move(lookup.done).Run(std::move(lookup.view));
}

// The app's answer, merged into the view. The app is authoritative while it is
// running: it is what will write the account file.
void MergeSignIn(mojom::SignInView* view, const base::DictValue& sign_in) {
  // `signedIn` is deliberately not taken from the app: the account file is what
  // every product reads, and the page has just read it (honouring the test
  // switch). The app's answer is the *flow* — the code, the page it opened, the
  // refusal — and that is what is merged here.
  const auto copy = [&sign_in](const char* key, std::string* field) {
    if (const std::string* value = sign_in.FindString(key)) {
      *field = *value;
    }
  };
  copy("state", &view->state);
  copy("userCode", &view->user_code);
  copy("verificationUrl", &view->verification_url);
  copy("email", &view->email);
  copy("name", &view->name);
  copy("message", &view->message);
}

mojom::ChatMessagePtr ToMessage(const base::DictValue& row) {
  mojom::ChatMessagePtr message = mojom::ChatMessage::New();
  if (const std::string* id = row.FindString("id")) {
    message->id = *id;
  }
  if (const std::string* role = row.FindString("role")) {
    message->role = *role;
  }
  if (const std::string* content = row.FindString("content")) {
    message->content = *content;
  }
  if (const std::string* status = row.FindString("status")) {
    message->status = *status;
  }
  if (const std::string* error = row.FindString("error")) {
    message->error = *error;
  }
  message->hidden = row.FindBool("hidden").value_or(false);
  // Advanced mode draws the way to an answer, not just the answer: the thinking
  // and the calls (each result is a separate `role: "tool"` row, keyed by the
  // call it belongs to). A simple-mode page simply never reads them.
  if (const std::string* reasoning = row.FindString("reasoning")) {
    message->reasoning = *reasoning;
  }
  if (const std::string* tool_call_id = row.FindString("toolCallId")) {
    message->tool_call_id = *tool_call_id;
  }
  if (const base::ListValue* calls = row.FindList("toolCalls")) {
    for (const base::Value& call : *calls) {
      if (!call.is_dict()) {
        continue;
      }
      mojom::ToolCallPtr step = mojom::ToolCall::New();
      if (const std::string* id = call.GetDict().FindString("id")) {
        step->id = *id;
      }
      if (const std::string* name = call.GetDict().FindString("name")) {
        step->name = *name;
      }
      if (const std::string* arguments = call.GetDict().FindString("arguments")) {
        step->arguments = *arguments;
      }
      message->tool_calls.push_back(std::move(step));
    }
  }
  if (const base::DictValue* fold = row.FindDict("compaction")) {
    mojom::CompactionPtr compaction = mojom::Compaction::New();
    compaction->messages = fold->FindInt("messages").value_or(0);
    // Rust writes these as integers, and `FindDouble` does not coerce one: a
    // count that parses as an int has to be read as an int (the same trap
    // `updatedAt` has in `ToSummary`).
    const auto count = [&fold](const char* key) -> double {
      if (std::optional<int> whole = fold->FindInt(key)) {
        return *whole;
      }
      return fold->FindDouble(key).value_or(0);
    };
    compaction->tokens_before = count("tokensBefore");
    compaction->tokens_after = count("tokensAfter");
    message->compaction = std::move(compaction);
  }
  return message;
}

}  // namespace

HookPageHandler::HookPageHandler(content::WebContents* web_contents,
                                 base::RepeatingClosure on_show_ui,
                                 base::RepeatingClosure on_close_ui)
    : web_contents_(web_contents),
      on_show_ui_(std::move(on_show_ui)),
      on_close_ui_(std::move(on_close_ui)) {}

HookPageHandler::~HookPageHandler() = default;

void HookPageHandler::Bind(mojo::PendingReceiver<mojom::PageHandler> receiver) {
  receiver_.reset();
  receiver_.Bind(std::move(receiver));
}

HookChannel* HookPageHandler::Channel() {
  if (!service_ && web_contents_) {
    service_ = BrowserService::For(
        Profile::FromBrowserContext(web_contents_->GetBrowserContext()));
  }
  return service_ ? service_->channel() : nullptr;
}

void HookPageHandler::GetTabs(GetTabsCallback callback) {
  std::vector<mojom::TabPtr> tabs;
  for (const HookTab& row : ReadAllTabs()) {
    mojom::TabPtr tab = mojom::Tab::New();
    tab->index = row.index;
    tab->id = row.id;
    tab->active = row.active;
    tab->title = row.title;
    tab->url = row.url;
    tab->domain = row.domain;
    tabs.push_back(std::move(tab));
  }
  std::move(callback).Run(std::move(tabs));
}

void HookPageHandler::ShowUI() {
  if (on_show_ui_) {
    on_show_ui_.Run();
  }
}

void HookPageHandler::CloseUI() {
  if (on_close_ui_) {
    on_close_ui_.Run();
  }
}

void HookPageHandler::GetChannel(GetChannelCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    std::move(callback).Run(false, "This page has no browser context.");
    return;
  }
  channel->Check(base::BindOnce(
      [](GetChannelCallback done, bool available, const std::string& reason) {
        std::move(done).Run(available, reason);
      },
      std::move(callback)));
}

void HookPageHandler::GetSettings(GetSettingsCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    std::move(callback).Run(false);
    return;
  }
  channel->Get("/settings",
                base::BindOnce(
                    [](GetSettingsCallback done,
                       std::optional<base::DictValue> body,
                       const std::string& /*error*/) {
                      // An older host does not have the route. That is the simple
                      // view, not a failure: the page still draws the chat.
                      std::move(done).Run(
                          body && body->FindBool("advancedMode").value_or(false));
                    },
                    std::move(callback)));
}

void HookPageHandler::ListChats(ListChatsCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    std::move(callback).Run({}, "This page has no browser context.");
    return;
  }
  channel->Get("/chats", base::BindOnce(
                             [](ListChatsCallback done,
                                std::optional<base::DictValue> body,
                                const std::string& error) {
                               if (!body) {
                                 std::move(done).Run({}, error);
                                 return;
                               }
                               std::vector<mojom::ChatSummaryPtr> chats;
                               if (const base::ListValue* rows =
                                       body->FindList("chats")) {
                                 for (const base::Value& row : *rows) {
                                   if (row.is_dict()) {
                                     chats.push_back(ToSummary(row.GetDict()));
                                   }
                                 }
                               }
                               std::move(done).Run(std::move(chats),
                                                   std::string());
                             },
                             std::move(callback)));
}

void HookPageHandler::GetChat(const std::string& id, GetChatCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    std::move(callback).Run(nullptr, "This page has no browser context.");
    return;
  }
  channel->Get(
      base::StringPrintf("/chats/%s", id.c_str()),
      base::BindOnce(
          [](GetChatCallback done, std::optional<base::DictValue> body,
             const std::string& error) {
            if (!body) {
              std::move(done).Run(nullptr, error);
              return;
            }
            const base::DictValue* view = body->FindDict("view");
            if (!view) {
              std::move(done).Run(nullptr, "Hook sent no conversation.");
              return;
            }
            const base::DictValue* chat = view->FindDict("chat");
            if (!chat) {
              std::move(done).Run(nullptr, "Hook sent no conversation.");
              return;
            }
            mojom::ChatViewPtr result = mojom::ChatView::New();
            result->chat = ToSummary(*chat);
            if (const base::ListValue* rows = view->FindList("messages")) {
              for (const base::Value& row : *rows) {
                if (row.is_dict()) {
                  result->messages.push_back(ToMessage(row.GetDict()));
                }
              }
            }
            std::move(done).Run(std::move(result), std::string());
          },
          std::move(callback)));
}

void HookPageHandler::CreateChat(CreateChatCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    std::move(callback).Run(std::string(), "This page has no browser context.");
    return;
  }
  channel->Post(
      "/chats", base::DictValue(),
      base::BindOnce(
          [](CreateChatCallback done, std::optional<base::DictValue> body,
             const std::string& error) {
            if (!body) {
              std::move(done).Run(std::string(), error);
              return;
            }
            const std::string* id = body->FindString("chatId");
            std::move(done).Run(id ? *id : std::string(),
                                id ? std::string() : "Hook created nothing.");
          },
          std::move(callback)));
}

namespace {

// One message on its way to the host: the text, and the frame that describes
// the page it is about.
void PostSend(HookChannel* channel,
              const std::string& id,
              const std::string& text,
              const std::string& context,
              mojom::PageHandler::SendMessageCallback done) {
  base::DictValue body;
  body.Set("text", text);
  body.Set("context", context);
  channel->Post(
      base::StringPrintf("/chats/%s/send", id.c_str()), body,
      base::BindOnce(
          [](mojom::PageHandler::SendMessageCallback finished,
             std::optional<base::DictValue> reply, const std::string& error) {
            std::move(finished).Run(reply.has_value(), error);
          },
          std::move(done)));
}

// What "this page" means in the message the agent receives: which tab, its
// title, its address, and the words the user highlighted. Cheap and stable, so
// it can travel with every message; the page's *text* does not, because that is
// tens of thousands of tokens the model may never need. It asks for that with
// `read_page` (see hook/browser/service/hook_service.cc).
std::string ContextFrame(content::WebContents* active,
                         const std::string& selection) {
  const std::vector<HookTab> tabs = ReadAllTabs();
  const std::optional<int> active_handle =
      active && tabs::TabInterface::GetFromContents(active)
          ? std::make_optional(
                tabs::TabInterface::GetFromContents(active)->GetHandle()
                    .raw_value())
          : std::nullopt;

  std::vector<std::string> lines;
  lines.push_back("Browser: Hook Browser");
  for (const HookTab& row : tabs) {
    if (active_handle && row.id == *active_handle) {
      lines.push_back(
          base::StringPrintf("Tab: %d of %zu", row.index + 1, tabs.size()));
      if (!row.title.empty()) {
        lines.push_back("Title: " + row.title);
      }
      if (!row.url.empty()) {
        lines.push_back("URL: " + row.url);
      }
      if (!selection.empty()) {
        // The backend caps the whole frame at 4000 characters; an address and a
        // title are worth more than the fourth paragraph of a highlight.
        lines.push_back("Selected: \"" + CapText(selection, 1500) + "\"");
      }
      return base::JoinString(lines, "\n");
    }
  }
  // No selected tab to describe (a window with no pages open): say what the
  // browser has instead of inventing a page.
  lines.push_back(base::StringPrintf("Tabs open: %zu", tabs.size()));
  return base::JoinString(lines, "\n");
}

}  // namespace

void HookPageHandler::SendMessage(const std::string& id,
                                  const std::string& text,
                                  SendMessageCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    std::move(callback).Run(false, "This page has no browser context.");
    return;
  }
  // The tab this message is about. `ActiveTabIn` answers for a page that is a
  // tab; the side panel is not one (its WebContents belongs to the panel view),
  // so it falls back to the most recently active window's tab — which is the
  // window the user is typing in.
  content::WebContents* active = ActiveTabIn(web_contents_.get());
  if (!active) {
    active = ActiveTab();
  }
  if (!active) {
    PostSend(channel, id, text, ContextFrame(nullptr, std::string()),
             std::move(callback));
    return;
  }
  // The highlight is read first, because it is part of the message: a turn that
  // started without it would answer about the wrong words.
  ReadSelection(
      active,
      base::BindOnce(
          [](base::WeakPtr<HookPageHandler> handler, std::string id,
             std::string text, SendMessageCallback done,
             const std::string& selection) {
            if (!handler) {
              std::move(done).Run(false, "This page went away.");
              return;
            }
            HookChannel* channel = handler->Channel();
            if (!channel) {
              std::move(done).Run(false, "This page has no browser context.");
              return;
            }
            content::WebContents* tab = ActiveTabIn(handler->web_contents_);
            if (!tab) {
              tab = ActiveTab();
            }
            PostSend(channel, id, text, ContextFrame(tab, selection),
                     std::move(done));
          },
          weak_factory_.GetWeakPtr(), id, text, std::move(callback)));
}

void HookPageHandler::StopMessage(const std::string& id) {
  HookChannel* channel = Channel();
  if (!channel) {
    return;
  }
  channel->Post(base::StringPrintf("/chats/%s/stop", id.c_str()),
                base::DictValue(),
                base::BindOnce([](std::optional<base::DictValue>,
                                  const std::string&) {}));
}

void HookPageHandler::ObserveChat(
    const std::string& id,
    mojo::PendingRemote<mojom::ChatObserver> observer) {
  HookChannel* channel = Channel();
  if (!channel) {
    mojo::Remote<mojom::ChatObserver> refused(std::move(observer));
    refused->OnChatEnd("No Hook is running on this computer.");
    return;
  }

  auto observation = std::make_unique<Observation>();
  observation->id = next_observation_++;
  observation->observer.Bind(std::move(observer));
  observation->observer.set_disconnect_handler(base::BindOnce(
      // Posted, never run inside the disconnect: the handler drops the observer
      // that is being told it is gone.
      [](base::WeakPtr<HookPageHandler> self, int id) {
        if (!self) {
          return;
        }
        base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
            FROM_HERE, base::BindOnce(&HookPageHandler::OnStreamEnd, self, id,
                                      std::string()));
      },
      weak_factory_.GetWeakPtr(), observation->id));

  const int id_of_stream = observation->id;
  observation->stream = channel->Open(
      base::StringPrintf("/chats/%s/events", id.c_str()),
      base::BindRepeating(&HookPageHandler::OnStreamFrame,
                          weak_factory_.GetWeakPtr(), id_of_stream),
      base::BindOnce(&HookPageHandler::OnStreamEnd,
                     weak_factory_.GetWeakPtr(), id_of_stream));
  observations_.push_back(std::move(observation));
}

HookPageHandler::Observation* HookPageHandler::FindObservation(int id) {
  for (const auto& observation : observations_) {
    if (observation->id == id) {
      return observation.get();
    }
  }
  return nullptr;
}

void HookPageHandler::OnStreamFrame(int id, const std::string& frame) {
  if (Observation* observation = FindObservation(id)) {
    observation->observer->OnChatEvent(frame);
  }
}

void HookPageHandler::OnStreamEnd(int id, const std::string& error) {
  Observation* observation = FindObservation(id);
  if (!observation) {
    return;
  }
  if (observation->observer.is_connected()) {
    observation->observer->OnChatEnd(error);
  }
  // Dropping it cancels the request, which is also what the host reads as "the
  // page is no longer watching this turn".
  std::erase_if(observations_,
                [id](const std::unique_ptr<Observation>& entry) {
                  return entry->id == id;
                });
}

void HookPageHandler::GetSignIn(GetSignInCallback callback) {
  auto lookup = std::make_shared<SignInLookup>();
  lookup->done = std::move(callback);
  // Re-read on every call, not from the gate's cache: the page polls this while
  // the app waits for an approval, and the same cache is what the navigation
  // gate consults. Refreshing it here is what lets the reload after approval
  // through, and it notices a sign-out just as quickly.
  account::RequestSignedIn(
      base::BindOnce(&HookPageHandler::OnSessionKnown,
                     weak_factory_.GetWeakPtr(), lookup),
      /*force=*/true);
}

void HookPageHandler::OnSessionKnown(std::shared_ptr<SignInLookup> lookup,
                                     bool signed_in) {
  lookup->view->signed_in = signed_in;
  lookup->view->state = signed_in ? "signed_in" : "signed_out";

  HookChannel* channel = Channel();
  if (!channel) {
    FinishSignIn(*lookup);
    return;
  }
  channel->Check(base::BindOnce(&HookPageHandler::OnChannelChecked,
                                weak_factory_.GetWeakPtr(), lookup));
}

void HookPageHandler::OnChannelChecked(std::shared_ptr<SignInLookup> lookup,
                                       bool available,
                                       const std::string& reason) {
  lookup->view->available = available;
  if (!available && !reason.empty()) {
    // The reason is what a person needs: no host anywhere, a host that would not
    // start, a channel file this browser cannot read. The card draws it.
    lookup->view->message = reason;
  }
  HookChannel* channel = Channel();
  if (!available || !channel) {
    FinishSignIn(*lookup);
    return;
  }
  channel->Get("/auth/status",
               base::BindOnce(&HookPageHandler::OnAuthStatus,
                              weak_factory_.GetWeakPtr(), lookup));
}

void HookPageHandler::OnAuthStatus(std::shared_ptr<SignInLookup> lookup,
                                   std::optional<base::DictValue> body,
                                   const std::string& error) {
  if (body) {
    if (const base::DictValue* sign_in = body->FindDict("signIn")) {
      MergeSignIn(lookup->view.get(), *sign_in);
    }
  }
  FinishSignIn(*lookup);
}

void HookPageHandler::StartSignIn(StartSignInCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    mojom::SignInViewPtr view = mojom::SignInView::New();
    std::move(callback).Run(std::move(view),
                            "This page has no browser context.");
    return;
  }
  channel->Check(base::BindOnce(&HookPageHandler::OnStartChannelChecked,
                                weak_factory_.GetWeakPtr(),
                                std::move(callback)));
}

void HookPageHandler::OnStartChannelChecked(StartSignInCallback callback,
                                             bool available,
                                             const std::string& reason) {
  HookChannel* channel = Channel();
  if (!available || !channel) {
    mojom::SignInViewPtr view = mojom::SignInView::New();
    view->state = "signed_out";
    std::move(callback).Run(
        std::move(view),
        "Start Hook to sign in. The browser borrows its account from the Hook "
        "app on this computer.");
    return;
  }
  channel->Post("/auth/start", base::DictValue(),
                base::BindOnce(&HookPageHandler::OnStartReply,
                               weak_factory_.GetWeakPtr(),
                               std::move(callback)));
}

void HookPageHandler::OnStartReply(StartSignInCallback callback,
                                   std::optional<base::DictValue> body,
                                   const std::string& error) {
  mojom::SignInViewPtr view = mojom::SignInView::New();
  view->available = true;
  if (body) {
    if (const base::DictValue* sign_in = body->FindDict("signIn")) {
      MergeSignIn(view.get(), *sign_in);
    }
  }
  std::move(callback).Run(std::move(view),
                          body ? std::string() : error);
}

void HookPageHandler::CancelSignIn() {
  HookChannel* channel = Channel();
  if (!channel) {
    return;
  }
  channel->Post("/auth/cancel", base::DictValue(),
                base::BindOnce([](std::optional<base::DictValue>,
                                  const std::string&) {}));
}

}  // namespace hook
