// Hook Browser: the shared account file, read once.

#include "hook/browser/account/hook_account.h"

#include <optional>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/values.h"
#include "hook/browser/account/hook_paths.h"

namespace hook::account {
namespace {

// The account file changes when a product signs in or out; a few seconds of
// staleness is cheaper than reading it on every navigation.
constexpr base::TimeDelta kCacheLifetime = base::Seconds(5);

// The parsed file, or nullopt when there is none. Blocking: thread pool only.
std::optional<base::DictValue> ReadFile() {
  const base::FilePath path = paths::AccountFile();
  if (path.empty()) {
    return std::nullopt;
  }
  std::string raw;
  if (!base::ReadFileToString(path, &raw)) {
    // No account file is the signed-out case, not an error: a fresh machine has
    // never signed in.
    return std::nullopt;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(raw, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return std::nullopt;
  }
  return std::move(*parsed).TakeDict();
}

// The session object, when the file holds one. `session` is null after signing
// out, and `token` is what every product presents.
const base::DictValue* Session(const base::DictValue& account) {
  return account.FindDict("session");
}

// What the last read found, shared by every caller on the UI thread. One read at
// a time: a burst of navigations after startup waits on the same task.
struct AccountState {
  std::optional<bool> signed_in;
  base::TimeTicks checked_at;
  bool reading = false;
  std::vector<base::OnceCallback<void(bool)>> waiters;

  bool IsFresh() const {
    return signed_in.has_value() && !checked_at.is_null() &&
           base::TimeTicks::Now() - checked_at < kCacheLifetime;
  }
};

AccountState& State() {
  // Process-lifetime, on purpose: no exit-time destructor, and every caller
  // shares the one answer.
  static base::NoDestructor<AccountState> state;
  return *state;
}

void OnAccountRead(bool signed_in) {
  AccountState& state = State();
  state.signed_in = signed_in;
  state.checked_at = base::TimeTicks::Now();
  state.reading = false;
  std::vector<base::OnceCallback<void(bool)>> waiters = std::move(state.waiters);
  state.waiters.clear();
  for (auto& waiter : waiters) {
    std::move(waiter).Run(signed_in);
  }
}

}  // namespace

bool ReadSignedIn() {
  const std::string forced =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII(
          kSignInStateSwitch);
  if (forced == "in") {
    return true;
  }
  if (forced == "out") {
    return false;
  }

  std::optional<base::DictValue> account = ReadFile();
  if (!account) {
    return false;
  }
  const base::DictValue* session = Session(*account);
  if (!session) {
    return false;
  }
  const std::string* token = session->FindString("token");
  return token && !token->empty();
}

void RequestSignedIn(base::OnceCallback<void(bool)> done, bool force) {
  AccountState& state = State();
  if (!force && state.IsFresh()) {
    std::move(done).Run(*state.signed_in);
    return;
  }
  state.waiters.push_back(std::move(done));
  if (state.reading) {
    return;
  }
  state.reading = true;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadSignedIn), base::BindOnce(&OnAccountRead));
}

Identity ReadIdentity() {
  Identity identity;
  std::optional<base::DictValue> account = ReadFile();
  if (!account) {
    return identity;
  }
  const base::DictValue* session = Session(*account);
  if (!session) {
    return identity;
  }
  if (const std::string* email = session->FindString("email")) {
    identity.email = *email;
  }
  if (const std::string* name = session->FindString("name")) {
    identity.name = *name;
  }
  return identity;
}

void Forget() {
  AccountState& state = State();
  state.signed_in = std::nullopt;
  state.checked_at = base::TimeTicks();
}

}  // namespace hook::account
