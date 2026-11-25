// Hook Browser: the browser's side of the page-read queue.

#include "hook/browser/service/hook_service.h"

#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/strings/stringprintf.h"
#include "base/time/time.h"
#include "chrome/browser/profiles/profile.h"
#include "hook/browser/channel/hook_channel.h"
#include "hook/browser/tabs/hook_page.h"
#include "hook/browser/tabs/hook_tabs.h"

namespace hook {

namespace {

// Keyed on nothing but its address: one service per profile.
constexpr char kBrowserServiceKey[] = "hook.browser.service";

// How often to ask when Hook is not running at all, and how often after a
// failed poll. A browser is not a reason to spin.
constexpr base::TimeDelta kIdleRetry = base::Seconds(10);
constexpr base::TimeDelta kFirstRetry = base::Seconds(2);

base::DictValue TabsAnswer() {
  base::ListValue rows;
  for (const HookTab& tab : ReadAllTabs()) {
    base::DictValue row;
    // One based: the number the model passes back, and what the frame prints.
    row.Set("tab", tab.index + 1);
    row.Set("window", tab.window);
    row.Set("title", tab.title);
    row.Set("url", tab.url);
    row.Set("active", tab.active);
    rows.Append(std::move(row));
  }

  base::DictValue answer;
  answer.Set("ok", true);
  answer.Set("tabs", std::move(rows));
  return answer;
}

}  // namespace

// static
BrowserService* BrowserService::For(Profile* profile) {
  if (!profile) {
    return nullptr;
  }
  auto* existing = static_cast<BrowserService*>(
      profile->GetUserData(kBrowserServiceKey));
  if (existing) {
    return existing;
  }
  // Not make_unique: the constructor is private, and a factory template is not
  // a member.
  std::unique_ptr<BrowserService> owned(new BrowserService(profile));
  BrowserService* service = owned.get();
  profile->SetUserData(kBrowserServiceKey, std::move(owned));
  return service;
}

BrowserService::BrowserService(Profile* profile) : profile_(profile) {}

BrowserService::~BrowserService() = default;

HookChannel* BrowserService::channel() {
  if (!channel_) {
    channel_ = std::make_unique<HookChannel>(profile_);
  }
  // A page that can reach a channel means a browser is in use; the queue should
  // be served from now on even if startup missed it (a profile created later).
  Start();
  return channel_.get();
}

void BrowserService::Start() {
  if (started_) {
    return;
  }
  started_ = true;
  // Not immediately: the browser is still finishing startup, and the host it
  // may want to start itself takes a moment to publish.
  Schedule(base::Seconds(1));
}

void BrowserService::Schedule(base::TimeDelta delay) {
  timer_.Start(FROM_HERE, delay,
               base::BindOnce(&BrowserService::Poll, weak_factory_.GetWeakPtr()));
}

void BrowserService::Poll() {
  if (polling_) {
    return;
  }
  polling_ = true;
  // A URLRequest that never calls back (a host that stopped answering mid
  // request, a socket that hangs) would otherwise leave `polling_` true for the
  // rest of the session, and the queue would silently stop being served.
  watchdog_.Start(FROM_HERE, base::Seconds(40),
                  base::BindOnce(&BrowserService::Unstick,
                                 weak_factory_.GetWeakPtr()));
  // The route holds the request open for a few seconds when there is no work,
  // so an idle browser is one request per hold rather than a busy loop.
  channel()->Get(
      "/browser/tasks",
      base::BindOnce(&BrowserService::OnPoll, weak_factory_.GetWeakPtr()));
}

void BrowserService::Unstick() {
  polling_ = false;
  Schedule(base::Seconds(1));
}

void BrowserService::OnPoll(std::optional<base::DictValue> body,
                            const std::string& error) {
  polling_ = false;
  watchdog_.Stop();
  if (!body) {
    ++failures_;
    Schedule(failures_ < 3 ? kFirstRetry : kIdleRetry);
    return;
  }
  // A host that does not understand the route answers 404 (which the channel
  // still parses as JSON). That is an older Hook, and this browser must not
  // spin 5 times a second against it: back off and try again later, when the
  // app has been updated.
  if (body->FindBool("ok") != true) {
    ++failures_;
    Schedule(kIdleRetry);
    return;
  }
  failures_ = 0;
  const base::DictValue* task = body->FindDict("task");
  if (!task) {
    // Nothing to do: the hold already waited. Ask again at once, because the
    // next one also waits.
    Schedule(base::Milliseconds(200));
    return;
  }
  RunTask(*task);
  // Work found: there may be more behind it.
  Schedule(base::Milliseconds(50));
}

void BrowserService::RunTask(const base::DictValue& task) {
  const std::string* id = task.FindString("id");
  const std::string* op = task.FindString("op");
  if (!id || !op) {
    return;
  }

  if (*op == "tabs") {
    base::DictValue answer = TabsAnswer();
    // The highlight is part of "what is on screen", and a tool asking about the
    // active tab should see it.
    content::WebContents* active = ActiveTab();
    if (!active) {
      Answer(*id, std::move(answer));
      return;
    }
    const std::string task_id = *id;
    base::WeakPtr<BrowserService> self = weak_factory_.GetWeakPtr();
    ReadSelection(active, base::BindOnce(
                              [](base::WeakPtr<BrowserService> service,
                                 std::string task_id, base::DictValue answer,
                                 const std::string& selection) {
                                answer.Set("selection", selection);
                                if (service) {
                                  service->Answer(task_id, std::move(answer));
                                }
                              },
                              self, task_id, std::move(answer)));
    return;
  }

  if (*op == "read") {
    const int number = task.FindInt("tab").value_or(0);
    content::WebContents* contents = FindTabByNumber(number);
    if (!contents) {
      base::DictValue answer;
      answer.Set("ok", false);
      answer.Set("error",
                 base::StringPrintf(
                     "There is no tab %d. It was closed, or the strip changed.",
                     number));
      Answer(*id, std::move(answer));
      return;
    }
    const std::string task_id = *id;
    base::WeakPtr<BrowserService> self = weak_factory_.GetWeakPtr();
    ReadPage(contents,
             base::BindOnce(
                 [](base::WeakPtr<BrowserService> service,
                    std::string task_id, PageRead page) {
                   base::DictValue answer;
                   answer.Set("ok", page.ok);
                   if (!page.ok) {
                     answer.Set("error", page.error);
                   } else {
                     answer.Set("title", page.title);
                     answer.Set("url", page.url);
                     answer.Set("text", page.text);
                     answer.Set("headings", std::move(page.headings));
                     answer.Set("truncated", page.truncated);
                   }
                   if (service) {
                     service->Answer(task_id, std::move(answer));
                   }
                 },
                 self, task_id));
    return;
  }

  base::DictValue answer;
  answer.Set("ok", false);
  answer.Set("error", "The browser does not know that request.");
  Answer(*id, std::move(answer));
}

void BrowserService::Answer(const std::string& id, base::DictValue reply) {
  channel()->Post(
      base::StringPrintf("/browser/tasks/%s", id.c_str()), reply,
      base::BindOnce([](std::optional<base::DictValue>, const std::string&) {}));
}

}  // namespace hook
