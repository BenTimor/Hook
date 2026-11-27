# Where the data lives

Every file Hook writes, what a debug build does differently, and where the Shared folder sits.

The tree below is Windows. macOS uses the same names and the same nesting under
`~/Library/Application Support/` — `app.hook.chat/` for a release build,
`hook-dev/app.hook.chat/` for a debug one, and `app.hook/` beside them for the
account, memory and the channel descriptor. Linux, where a product links the
same crate without a window, uses `$XDG_DATA_HOME` (or
`~/.local/share/`). Nothing below the root changes between them.

```
%APPDATA%\app.hook\
  account.json             the signed-in account, shared by every Hook product
                           on this machine (signing in to one signs in all)
  memory\                  what the chat agent remembers, one file per account,
                           shared by every product (see docs/memory.md)
    owner.json             the account last in use, so the list does not empty
                           itself on sign-out
    <account>.json         the entries: text, kind, pin, source chat, revision

%APPDATA%\app.hook.chat\      Hook's own data
  chats\<id>.json          one readable JSON file per conversation; a
                           `"kind": "coding"` file is a coding-agent chat and
                           stays on this machine
  trash\                   undoable deletions: a chat is <chat id>.json, and
                           projects\<project id>\ is a removed project's folder,
                           listed in projects.json and deleted after seven days
                           (the project's git repository on the account is what
                           holds its code after that)
  images\<chat id>\        pictures attached to messages (bytes on disk)
  settings.json            projects folder, memory switch, the advanced-mode
                           fallback, and a personal model endpoint and key if
                           one was entered (0600 on Unix). A paid account with
                           cloud sync on also has one encrypted copy on the
                           account, so the other products adopt it.
  projects.json            the notes the chat agent keeps about projects
  agents.json              coding-agent runs and their states
  auth.json                a mirror of the shared account, so a downgrade works
  device.json              this installation's id (git tokens rotate per device;
                           machine names and presence live on the account)
  sync.json                the sync cursor, pending uploads and account owner
  accounts\<id>\           conversations moved aside when a different account
                           signs in on this machine (never uploaded)
  agent-sessions\          coding-engine session files (resumable)
  agent-home\              the engine's own config: models.json (endpoint,
                           model and `$HOOK_*` header references), gitconfig
                           (managed git identity and the scoped git token),
                           settings.json
  updates\<agent id>\      progress notes, checklist updates and preview pointers
                           the agents wrote, collected each second; a direct
                           agent's `tools.json` (bridge endpoint, token, tool
                           list) and `memory.txt` (the pinned memories its
                           prompt starts with)
  hook-guard.mjs           the guard loaded into every coding agent

%APPDATA%\hook-dev\          only a debug build: `pnpm app`, `cargo run`
  app.hook\                  account.json, memory\ and the browser channel
  app.hook.chat\             the product folder, laid out exactly as above
```

A **debug build** — `pnpm app`, `pnpm workspace:app`, `cargo run` — uses those
`hook-dev` folders instead (on macOS:
`~/Library/Application Support/hook-dev/app.hook.chat/`), one level deeper, so
it has its own sign-in, device id, chats, sync cursor and agent home. Two live Hooks that shared a folder would
write over each other — the second one to start turns a running coding agent's
reply into an error (`coding.rs::recover`), the sync cursor flips back and forth,
and the relay sees one machine connected twice. Signing in there registers a
second machine on the account under the same computer name, so rename the dev
one in Settings. `HOOK_DATA_DIR` picks the folder explicitly, for a debug build
that does have to read the installed data; delete `%APPDATA%\hook-dev\` (macOS:
`~/Library/Application Support/hook-dev/`) to reset it.

Hook Workspace writes to `%APPDATA%\app.hook.workspace\` and reads the same
`%APPDATA%\app.hook\account.json`, so the two products never ask for a sign-in
twice; its cached data and the service it talks to are documented in
[Hook Workspace](workspace.md).

Hook Browser's host (`crates/hook-host`, started by the browser) writes to
`%APPDATA%\app.hook.browser\`: its own chats, settings and agent home, the same
account, and its own `browser-channel.browser.json` in the shared `app.hook\`
folder beside Hook's. Two products hosting a channel at once is why that
descriptor is named per product. The browser's history is its own until sync
reconciles it with the account, the same way Workspace's is.

The Microsoft Store (MSIX) build writes to the same `%APPDATA%\app.hook.chat`
folder: its manifest opts out of AppData virtualization so Store and direct
installs share chats and sign-in. In-app updates download installers to
`%TEMP%\hook-update\`; nothing else is written outside this folder. A debug build
is not part of either channel; it uses `%APPDATA%\hook-dev\` above.

A macOS build uses the same product folder and never offers an in-app update
yet: the published release index names NSIS installers, so `hook-core` reports
`UpdateChannel::Manual` there and the window shows no banner. Replacing
`Hook.app` from a `.dmg` is the manual path until a macOS release channel exists.

---

[Documentation](README.md) · [Hook](../README.md)
