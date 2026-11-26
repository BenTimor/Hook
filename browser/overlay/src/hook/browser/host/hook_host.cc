// Hook Browser: starting the Hook host this browser talks to.

#include "hook/browser/host/hook_host.h"

#include <optional>
#include <utility>
#include <vector>

#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/memory/scoped_refptr.h"
#include "base/path_service.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/process/process_handle.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/task_traits.h"
#include "base/task/thread_pool.h"
#include "base/threading/thread_checker.h"
#include "base/time/time.h"
#include "build/build_config.h"
#include "content/public/browser/browser_thread.h"
#include "hook/browser/account/hook_account.h"
#include "hook/browser/account/hook_paths.h"
#include "hook/browser/channel/hook_descriptor.h"

namespace hook::host {
namespace {

// A host boots in a second or two. The wait covers a cold disk and a machine busy
// with a build, and gives up rather than leaving the sign-in card spinning.
constexpr base::TimeDelta kWaitForDescriptor = base::Seconds(20);
constexpr base::TimeDelta kPollInterval = base::Milliseconds(250);

#if BUILDFLAG(IS_WIN)
constexpr char kHostBinary[] = "hook-host.exe";
constexpr wchar_t kDataDirVariable[] = L"HOOK_DATA_DIR";
#else
constexpr char kHostBinary[] = "hook-host";
constexpr char kDataDirVariable[] = "HOOK_DATA_DIR";
#endif

// The browser's own host, so the browser's own folder: `Product::Browser` in
// `hook-core` keeps its chats in `%APPDATA%\app.hook.browser`, beside the account
// every product shares. Naming it here is what keeps the browser's gate and the
// channel looking at one account even when this host is a dev build (which would
// otherwise nest itself under `hook-dev`).
constexpr char kHostProductFolder[] = "app.hook.browser";

// A packaged browser ships the host next to itself. A dev tree has no such file,
// so the build writes the path to the repository's binary into the GN args —
// fixed at build time, which is the only kind of path this may execute.
base::FilePath ResolveHostPath() {
  base::FilePath dir;
  if (base::PathService::Get(base::DIR_EXE, &dir)) {
    const base::FilePath beside = dir.AppendASCII(kHostBinary);
    if (base::PathExists(beside)) {
      return beside;
    }
  }
#if defined(HOOK_HOST_PATH)
  const base::FilePath dev(FILE_PATH_LITERAL(HOOK_HOST_PATH));
  if (!dev.empty() && base::PathExists(dev)) {
    return dev;
  }
#endif
  return base::FilePath();
}

class Launcher {
 public:
  Launcher() = default;
  Launcher(const Launcher&) = delete;
  Launcher& operator=(const Launcher&) = delete;

  // Any sequence: the ask comes from the page handler (UI thread) and from the
  // channel's probe, whose reply can land on the pool. The launcher's own state
  // belongs to the UI thread, so an ask from elsewhere is handed over.
  void Ask(StartedCallback done) {
    const scoped_refptr<base::SequencedTaskRunner> ui =
        content::GetUIThreadTaskRunner({});
    if (ui->RunsTasksInCurrentSequence()) {
      EnsureRunning(std::move(done), ui);
      return;
    }
    // `base::Unretained` rather than a weak pointer on purpose: the launcher is a
    // process-lifetime singleton (`NoDestructor` below), so there is no lifetime
    // to guard, and a `WeakPtr` would be the thing that breaks here — this ask can
    // arrive on a pool thread (the channel's `/health` reply), and a weak
    // reference made there is bound to that sequence, so the UI thread may not
    // dereference it.
    ui->PostTask(FROM_HERE, base::BindOnce(&Launcher::EnsureRunning,
                                           base::Unretained(this), std::move(done),
                                           ui));
  }

 private:
  enum class State { kIdle, kStarting, kRunning, kFailed };

  // Answers go back on the sequence that asked. A caller is `WeakPtr`-bound to its
  // own sequence, and running its callback from another one trips the weak
  // reference's sequence check — which is how a host that launched correctly still
  // took the browser down.
  struct Waiter {
    scoped_refptr<base::SequencedTaskRunner> runner;
    StartedCallback done;
  };

  void EnsureRunning(StartedCallback done,
                     scoped_refptr<base::SequencedTaskRunner> runner) {
    DCHECK_CALLED_ON_VALID_THREAD(thread_checker_);
    // A host this browser started can be closed or crash while the window stays
    // open. That is not a success to remember: the next ask is a fresh attempt,
    // or the user would have to restart the browser to get a host back.
    if (state_ == State::kRunning && !ChildAlive()) {
      state_ = State::kIdle;
    }
    switch (state_) {
      case State::kRunning:
        Answer(std::move(runner), std::move(done), true, std::string());
        return;
      case State::kFailed:
        // Sticky on purpose: a binary that is not installed will not appear in
        // the next second, and relaunching on every page load would only repeat
        // the sentence the card already shows.
        Answer(std::move(runner), std::move(done), false, failure_);
        return;
      case State::kStarting:
        waiters_.push_back({std::move(runner), std::move(done)});
        return;
      case State::kIdle:
        break;
    }
    waiters_.push_back({std::move(runner), std::move(done)});
    Start();
  }

  static void Answer(scoped_refptr<base::SequencedTaskRunner> runner,
                     StartedCallback done,
                     bool started,
                     const std::string& reason) {
    std::string copy = reason;
    runner->PostTask(
        FROM_HERE,
        base::BindOnce(std::move(done), started, std::move(copy)));
  }

  // What a launch attempt produced: the child, or the sentence the card shows.
  struct LaunchOutcome {
    std::optional<base::Process> child;
    std::string reason;
  };

  void Start() {
    DCHECK_CALLED_ON_VALID_THREAD(thread_checker_);
    state_ = State::kStarting;

    // Everything below touches the disk, and the ask can arrive during startup
    // tasks — the gate probes the channel while the first navigation is being
    // throttled, and that scope forbids blocking (`BrowserMainLoop`'s
    // `DisallowUnresponsiveTasks`). So the path, the environment and the launch
    // run on a pool that may block, and the child comes back here.
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE,
        {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
         base::TaskShutdownBehavior::CONTINUE_ON_SHUTDOWN},
        base::BindOnce(&Launcher::LaunchNow),
        base::BindOnce(&Launcher::OnLaunched, base::Unretained(this)));
  }

  // The blocking half of `Start`, and static so it owns nothing the UI thread
  // owns: resolving the host stats two files, and the launch itself reads the
  // environment it copies.
  static LaunchOutcome LaunchNow() {
    const base::FilePath path = ResolveHostPath();
    if (path.empty()) {
      return {std::nullopt, "Hook's host is not installed on this computer."};
    }

    // No switches: `hook-host` has no window to suppress and no mode to choose.
    // It is the backend with a channel, and that is all it is.
    base::CommandLine command_line(path);

    base::LaunchOptions options;
#if BUILDFLAG(IS_WIN)
    // No console window on someone's desktop: the host is an implementation
    // detail, not a program they started.
    options.start_hidden = true;
#endif

    // The host has to see the same account this browser's gate reads, or the card
    // would say "signed in" while the channel served nothing. A *debug* host keeps
    // its data under `%APPDATA%\hook-dev\app.hook\` (`lib.rs::resolve_data_dir`)
    // and publishes its channel there, where a browser reading `%APPDATA%\app.hook\`
    // never looks — so the folder is named explicitly, and the two agree whichever
    // build each of them is. (`HOOK_DATA_DIR` is `hook-core`'s own override.)
    const base::FilePath shared = paths::SharedDir();
    if (!shared.empty()) {
      const base::FilePath host_dir =
          shared.DirName().AppendASCII(kHostProductFolder);
      options.environment.emplace(kDataDirVariable, host_dir.value());
    }

    base::Process launched = base::LaunchProcess(command_line, options);
    if (!launched.IsValid()) {
      return {std::nullopt, "Hook's host would not start on this computer."};
    }
    return {std::move(launched), std::string()};
  }

  void OnLaunched(LaunchOutcome outcome) {
    DCHECK_CALLED_ON_VALID_THREAD(thread_checker_);
    if (state_ != State::kStarting) {
      // The browser went away while the child was being started.
      return;
    }
    if (!outcome.child.has_value()) {
      Finish(false, outcome.reason);
      return;
    }
    pid_ = outcome.child->Pid();
    started_at_ = base::TimeTicks::Now();

#if BUILDFLAG(IS_WIN)
    // Kill with the browser: one browser, one host, no orphans
    // (docs/browser-host.md, "Starting it"). `chrome_exe_main_win.cc` owns the
    // process-wide AtExitManager, so this runs on every orderly exit. A browser
    // that is killed outright skips it — the descriptor's pid is what makes a
    // survivor read as dead, and a later run launches nothing new while it
    // answers. The duplicate keeps `IsRunning()` working on `child_`.
    base::AtExitManager::RegisterTask(
        base::BindOnce([](base::Process child) { child.Terminate(0, false); },
                       outcome.child->Duplicate()));
#endif

    child_ = std::move(*outcome.child);
    SchedulePoll();
  }

  // The descriptor is a file, so it is read where blocking is allowed. A tick
  // that finds nothing is cheap: one small read every 250 ms while a child boots.
  void SchedulePoll() {
    base::ThreadPool::PostDelayedTask(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&Launcher::ReadOnPool, base::Unretained(this)),
        kPollInterval);
  }

  void ReadOnPool() {
    const ChannelDescriptor descriptor = ReadChannelDescriptor();
    const bool ours =
        descriptor.pid != 0 && descriptor.pid == static_cast<int>(pid_);
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE, base::BindOnce(&Launcher::OnPolled,
                                  base::Unretained(this), ours));
  }

  void OnPolled(bool ours) {
    DCHECK_CALLED_ON_VALID_THREAD(thread_checker_);
    if (state_ != State::kStarting) {
      return;
    }
    if (ours) {
      Finish(true, std::string());
      return;
    }
    if (base::TimeTicks::Now() - started_at_ > kWaitForDescriptor) {
      Finish(false,
             "Hook's host is starting, but it has not published its channel.");
      return;
    }
    SchedulePoll();
  }

  // Windows is the only platform whose `Process` can answer this without a
  // syscall (`IsRunning`); everywhere else the `/health` probe decides, which is
  // what the caller does anyway.
  bool ChildAlive() const {
#if BUILDFLAG(IS_WIN)
    return child_.has_value() && child_->IsValid() && child_->IsRunning();
#else
    return true;
#endif
  }

  void Finish(bool started, const std::string& reason) {
    DCHECK_CALLED_ON_VALID_THREAD(thread_checker_);
    state_ = started ? State::kRunning : State::kFailed;
    failure_ = reason;
    // Drain into a local first: a callback may call `EnsureRunning` again, and it
    // has to see the finished state rather than the vector being walked.
    std::vector<Waiter> waiters = std::move(waiters_);
    waiters_.clear();
    for (Waiter& waiter : waiters) {
      Answer(std::move(waiter.runner), std::move(waiter.done), started, reason);
    }
  }

  State state_ = State::kIdle;
  base::ProcessId pid_ = base::kNullProcessId;
  std::optional<base::Process> child_;
  base::TimeTicks started_at_;
  std::string failure_;
  std::vector<Waiter> waiters_;
  // Only read by DCHECK_CALLED_ON_VALID_THREAD, and a shipping build compiles
  // DCHECKs out: without this, -Wunused-private-field fails the build.
  [[maybe_unused]] base::ThreadChecker thread_checker_;
};

}  // namespace

bool LaunchingAllowed() {
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(kNoHostSwitch)) {
    return false;
  }
  // `--hook-signin-state` proves the gate on a machine whose account file has a
  // session, and the check runs must not leave a host behind afterwards.
  return !command_line->HasSwitch(account::kSignInStateSwitch);
}

void EnsureRunning(StartedCallback done) {
  static base::NoDestructor<Launcher> launcher;
  launcher->Ask(std::move(done));
}

}  // namespace hook::host
