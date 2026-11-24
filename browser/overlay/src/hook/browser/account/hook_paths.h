// Hook Browser: where Hook's shared files are.
//
// Both the sign-in gate (which reads the account) and the browser channel (which
// reads the descriptor a running Hook app publishes) need the same folder, so the
// platform mapping is written once: the equivalent of `hook-core`'s
// `app_data_dir().parent()`.

#ifndef HOOK_BROWSER_ACCOUNT_HOOK_PATHS_H_
#define HOOK_BROWSER_ACCOUNT_HOOK_PATHS_H_

#include "base/files/file_path.h"

namespace hook::paths {

// `%APPDATA%\app.hook` on Windows, `~/Library/Application Support/app.hook` on
// macOS, `$XDG_DATA_HOME/app.hook` (or `~/.local/share/app.hook`) elsewhere.
// Empty when the platform directory cannot be resolved.
base::FilePath SharedDir();

// The account every Hook product shares: `SharedDir()/account.json`.
base::FilePath AccountFile();

// The loopback channel a Hook host publishes while it runs:
// `SharedDir()/browser-channel.json`. Which host is not this file's business —
// the app in the tray, or the one the browser started itself.
base::FilePath ChannelDescriptorFile();

}  // namespace hook::paths

#endif  // HOOK_BROWSER_ACCOUNT_HOOK_PATHS_H_
