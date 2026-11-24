// Hook Browser: where Hook's shared files are.

#include "hook/browser/account/hook_paths.h"

#include <cstdlib>

#include "base/path_service.h"
#include "build/build_config.h"

namespace hook::paths {
namespace {

constexpr char kSharedDirName[] = "app.hook";

base::FilePath PlatformDataDir() {
  base::FilePath dir;
#if BUILDFLAG(IS_WIN)
  if (!base::PathService::Get(base::DIR_ROAMING_APP_DATA, &dir)) {
    return base::FilePath();
  }
#elif BUILDFLAG(IS_MAC)
  if (!base::PathService::Get(base::DIR_APP_DATA, &dir)) {
    return base::FilePath();
  }
#else
  // `hook-core` writes under Tauri's app data dir, whose parent on Linux is the
  // XDG data home.
  const char* data_home = std::getenv("XDG_DATA_HOME");
  if (data_home && *data_home) {
    dir = base::FilePath(data_home);
  } else if (!base::PathService::Get(base::DIR_HOME, &dir)) {
    return base::FilePath();
  } else {
    dir = dir.AppendASCII(".local").AppendASCII("share");
  }
#endif
  return dir;
}

}  // namespace

base::FilePath SharedDir() {
  const base::FilePath dir = PlatformDataDir();
  return dir.empty() ? base::FilePath() : dir.AppendASCII(kSharedDirName);
}

base::FilePath AccountFile() {
  const base::FilePath dir = SharedDir();
  return dir.empty() ? base::FilePath() : dir.AppendASCII("account.json");
}

std::vector<base::FilePath> ChannelDescriptorFiles() {
  std::vector<base::FilePath> files;
  const base::FilePath dir = SharedDir();
  if (dir.empty()) {
    return files;
  }
  // The browser's own host first: it is the one this browser launched, in its own
  // folder, and it is the only descriptor whose pid can match the child the
  // launcher started. The chat app is the useful fallback (it hosted this channel
  // before the browser had a host), Workspace is the other desktop product, and a
  // phone has no folder on this machine. The bare name is what every build before
  // the per-product split wrote, so a host that has not been rebuilt is still
  // found.
  for (const char* name :
       {"browser-channel.browser.json", "browser-channel.chat.json",
        "browser-channel.workspace.json", "browser-channel.json"}) {
    files.push_back(dir.AppendASCII(name));
  }
  return files;
}

}  // namespace hook::paths
