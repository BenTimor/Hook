// Hook Browser: where Hook's shared files are.
//
// Both the sign-in gate (which reads the account) and the browser channel (which
// reads the descriptor a running Hook app publishes) need the same folder, so the
// platform mapping is written once: the equivalent of `hook-core`'s
// `app_data_dir().parent()`.

#ifndef HOOK_BROWSER_ACCOUNT_HOOK_PATHS_H_
#define HOOK_BROWSER_ACCOUNT_HOOK_PATHS_H_

#include <vector>

#include "base/files/file_path.h"

namespace hook::paths {

// `%APPDATA%\app.hook` on Windows, `~/Library/Application Support/app.hook` on
// macOS, `$XDG_DATA_HOME/app.hook` (or `~/.local/share/app.hook`) elsewhere.
// Empty when the platform directory cannot be resolved.
base::FilePath SharedDir();

// The account every Hook product shares: `SharedDir()/account.json`.
base::FilePath AccountFile();

// Every loopback channel a host may have published, most specific first:
// `browser-channel.browser.json` (the host this browser started), then the other
// products that may be running beside it, then the pre-step-4 file name. One file
// per product, because the folder is shared and two hosts running at once is
// normal once the browser has a host of its own.
std::vector<base::FilePath> ChannelDescriptorFiles();

}  // namespace hook::paths

#endif  // HOOK_BROWSER_ACCOUNT_HOOK_PATHS_H_
