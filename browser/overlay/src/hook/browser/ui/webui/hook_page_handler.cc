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
#include "base/strings/stringprintf.h"
#include "base/values.h"
#include "hook/browser/account/hook_account.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_contents.h"
#include "hook/browser/tabs/hook_tabs.h"
#include "hook/common/hook.mojom.h"

namespace hook {
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
  return message;
}

}  // namespace

HookPageHandler::HookPageHandler(content::WebContents* web_contents,
                                 base::RepeatingClosure on_show_ui)
    : web_contents_(web_contents), on_show_ui_(std::move(on_show_ui)) {}

HookPageHandler::~HookPageHandler() = default;

void HookPageHandler::Bind(mojo::PendingReceiver<mojom::PageHandler> receiver) {
  receiver_.reset();
  receiver_.Bind(std::move(receiver));
}

HookChannel* HookPageHandler::Channel() {
  if (!channel_ && web_contents_) {
    channel_ = std::make_unique<HookChannel>(
        Profile::FromBrowserContext(web_contents_->GetBrowserContext()));
  }
  return channel_.get();
}

void HookPageHandler::GetTabs(GetTabsCallback callback) {
  std::vector<mojom::TabPtr> tabs;
  for (const HookTab& row : ReadTabs(web_contents_.get())) {
    mojom::TabPtr tab = mojom::Tab::New();
    tab->index = row.index;
    tab->id = row.id;
    tab->active = row.active;
    tab->title = row.title;
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

void HookPageHandler::SendMessage(const std::string& id,
                                  const std::string& text,
                                  const std::string& context,
                                  SendMessageCallback callback) {
  HookChannel* channel = Channel();
  if (!channel) {
    std::move(callback).Run(false, "This page has no browser context.");
    return;
  }
  base::DictValue body;
  body.Set("text", text);
  body.Set("context", context);
  channel->Post(
      base::StringPrintf("/chats/%s/send", id.c_str()), body,
      base::BindOnce(
          [](SendMessageCallback done, std::optional<base::DictValue> reply,
             const std::string& error) {
            std::move(done).Run(reply.has_value(), error);
          },
          std::move(callback)));
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
