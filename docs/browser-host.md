# Hook Browser — its own host process

> **Status: steps 1–4 are in.** The host is `crates/hook-host`, a plain Rust
> binary with no Tauri at all; it is `Product::Browser` with its own folder
> (`%APPDATA%\app.hook.browser`) and its own descriptor
> (`browser-channel.browser.json`), and the browser starts it when no channel
> answers (`browser/overlay/src/hook/browser/host/hook_host.cc` — one launch per
> run, a build-time path, a pid that must be the child's, `--hook-no-host` to turn
> it off). What that means in practice: Hook Browser needs no other product
> installed, running, or even built. What is left is packaging (step 5).

## The question

The browser's chat surface and its sign-in card are served by a loopback channel
(`crates/hook-core/src/channel.rs`) published by a Hook process. Which process
is not obvious, because the channel is started in `hook-core`'s shared `setup()`
(`crates/hook-core/src/lib.rs`), not in a product:

- **Every product hosts it** — Hook, Hook Workspace, the phone — with the same
  routes and the same account.
- **The data is per product.** `app_data_dir()` is the product's own folder
  (`%APPDATA%\app.hook.chat`, `app.hook.workspace`, `app.hook.mobile`), so a
  Workspace host would serve *Workspace's* chats, not the chat app's. Only the
  account (`%APPDATA%\app.hook\account.json`) is shared.
- **The browser ignores which one answered.** `/health` reports `"product"`, and
  nothing in `browser/channel/` reads it.

So the honest statement today is: the browser needs *a* Hook process, and since
step 1 it starts one itself when none answers — but the content still depends on
which product's binary it started, and that is a coincidence of where the channel
was put, not a design.

The preferred shape, and the one this document specifies, is:

> The browser is a product like the other two. It runs its own host process, in
> its own data folder, syncing the same account — and it needs no other product
> running to sign in, read a conversation or send a message.

## Two ways to get there

| | Browser spawns a host process | Link the backend into the browser |
| --- | --- | --- |
| How | `base::LaunchProcess` on a small `hook-host` binary when no channel answers | Build `hook-core` as a Rust static lib with a C ABI and call it from the browser process |
| Where the token lives | In the host; the page and the browser process only read a descriptor | In the browser process |
| Build system | A second Rust binary, copied next to `chrome.exe` | A Rust toolchain inside GN, a C ABI, an async runtime inside Chromium |
| Failure surface | A process that fails to start (a sentence on the card) | A crash in `chrome.dll`, and a licence/security story to redo |
| Cost | Days for the interim, one to two weeks for the clean version | Weeks, and a permanent cross-language build |
| Verdict | **Chosen** | Rejected |

The channel exists precisely so the browser never holds the credential: a
`chrome://` renderer cannot make the request, the browser process makes it, and
the token stays in the host. Linking the backend into the browser throws that
away, and buys nothing the process does not.

## The design point: the browser is a product

`Product` is already `Chat | Workspace | Mobile`, and `Capabilities` already trims
the prompt and the toolset per product without touching the data model
(`AGENTS.md`, "New product"). The browser host is a fourth entry, not a special
case:

- `Product::Browser` and `Capabilities::browser()` in `hook-core` — no coding
  agents on this machine (the browser can drive remote ones), no local project
  folder, preview workspace yes, chat yes.
- Its own data folder `%APPDATA%\app.hook.browser`, so its chats are its own and
  cannot be confused with the chat app's or Workspace's.
- The same sync engine, account-scoped, so the conversations still meet the
  account. This is the same mechanism that already reconciles Hook and Hook
  Workspace, and it is why "its own folder" does not mean "a separate history".
- Its settings file (`settings.json`) is its own, as every product's is.

With that, "which daemon" stops being a question: the browser's host is the
browser's, and another product's channel is simply another host on the machine.

## The host binary

`--headless` *was* the Tauri app with its window hidden: it still created a
webview, still carried Wry and the window resources, and was compiled for
`Product::Chat`. That is why the first version of this borrowed the chat app. The
host is now `crates/hook-host`, a plain Rust binary that links `hook-core` with
`default-features = false`:

- `hook-core`'s stores, `auth.rs`, `sync.rs`, `turn.rs`, `tools.rs`, the channel
  — everything but `lib.rs`'s Tauri builder.
- No webview, no tray, no window, no plugins it does not use. Expect roughly the
  size of the desktop backend without the window stack.
- It writes `browser-channel.browser.json` (`Channel::serve` already does) and
  runs until it is asked to stop — Ctrl+C, or the browser terminating it.

The refactor that paid for it: **`AppState` was built around `AppHandle`**. Event
emission (`emit_auth`, `emit_chat`, the sync and preview events) and
`tauri::async_runtime::spawn` were used across `commands.rs`, `turn.rs`,
`sync.rs` and `coding.rs`. Now:

- `events::EventSink` is the trait — `emit_value(&self, event, payload)`, with
  `EmitExt` restoring the generic `emit` the call sites had, `events::TauriSink`
  over `AppHandle::emit` behind the `desktop` feature, and `events::NoopSink` for
  a process with no window. `AppState.events` replaced `AppState.app`.
- `rt` owns the runtime handle: `rt::set` once at startup (Tauri's handle for a
  window, the host's own for the browser) and `rt::spawn`/`spawn_blocking`
  everywhere. `Handle::spawn` needs no reactor, so the "no reactor running" panic
  that used to abort a window from a command thread cannot happen.
- `hooks-core`'s Tauri is a feature (`default = ["desktop"]`), so
  `default-features = false` compiles the backend without `commands.rs`,
  `update.rs` or any Tauri type. `boot::start(StartOptions)` builds the state for
  both a window and the host; `lib.rs` keeps only the window.
- `AppState` moved to `state.rs` and the operations three surfaces share (send,
  stop, delete, sign-in, an RPC) to `session.rs`, because the channel and the
  relay call them too. `ChannelBackend` does not change, and neither do the
  routes.

## Starting it

The browser starts the host, on demand, once per browser run — implemented in
`browser/overlay/src/hook/browser/host/hook_host.cc`:

1. `/health` did not answer → launch the host with `base::LaunchProcess` (no
   shell), from a **fixed path** resolved at build time: `hook.exe` beside
   `chrome.exe` for a packaged build, and `hook_host_path` from the GN args for a
   dev tree (`browser/tools/build.mjs` writes the repository's debug binary into
   `out/Dev/args.gn`, so `browser/args.gn` stays machine-agnostic). A path that
   comes from a page, a preference or an environment variable is not something
   the browser may execute.
2. Wait for the descriptor and require its `pid` to be the child's. A descriptor
   written by another product is not ours to use, and a stale one must not send
   the browser to a dead port.
3. Launch it with `HOOK_DATA_DIR` set to `<shared dir>/app.hook.browser`. The host
   must see the account this browser's gate reads, and a *debug* host would
   otherwise keep its data under `%APPDATA%\hook-dev\app.hook\`
   (`lib.rs::resolve_data_dir`) and publish its channel where the browser never
   looks. Naming the folder makes a dev host and a packaged browser agree, which
   is what makes `pnpm browser:smoke --host` testable in a dev tree at all.
4. `--hook-no-host` disables the launch entirely, so a machine that runs Hook by
   hand and the smoke check can prove the signed-out card without a host. Any
   `--hook-signin-state` does too: a test seam must not leave processes behind.
5. The attempt is remembered for the life of the process: one launch, no loop. A
   second page asking at the same moment shares the same wait. If the host it
   started exits, the next ask launches again — otherwise closing a stray host
   would need a browser restart.

Exit policy, decided: **kill with the browser**.

- **Kill with its browser** keeps the machine clean and makes the host an
  implementation detail, but a turn still streaming when the window closes dies
  with it.
- **Outlive the browser** lets a long turn finish and lets the next window reuse
  the host; it needs the stale-descriptor reaping the channel already implies
  (a descriptor whose pid is gone reads as "not running").

The channel's `Check()` is already that reaper — the descriptor's `pid` is written
today (`Channel::write_descriptor`) — so either policy was cheap. Step 1 takes
the first: the child is terminated from the process-wide `AtExitManager`, which
Windows' entry point owns (`chrome/app/chrome_exe_main_win.cc`). A browser killed
outright skips it, which is why "available" is `/health` and not "a file exists"
— a survivor answers, so the next run reuses it instead of piling up a second one.

## The descriptor is per product

It was one file in a folder every product shares, so the last process to start won
it. Two products running (the app in the tray, the browser's own host) is the
normal case once the browser is a product, and they must not fight over the name.

It is now `browser-channel.<product>.json` — `browser-channel.chat.json`,
`browser-channel.browser.json` — written by `Channel::serve` from the backend's
`product()`, which is `Product::slug()`. `hook_paths::ChannelDescriptorFiles()`
lists them in the order the browser reads them: its own, then the chat app (which
hosted this channel before the split), then Workspace, then the bare
`browser-channel.json` of a host that has not been rebuilt. A file that exists and
cannot be parsed stops the search — a corrupt descriptor of our own must not send
the browser to another product's token.

## What does not change

- **The page.** `browser/ui/transport.ts` is a `ChatTransport` over mojom; the
  routes behind it are the same. Sign-in stays `StartSignIn` → `/auth/start` →
  poll `GetSignIn` → reload.
- **The gate.** It reads the account file, not the channel. That the browser can
  browse with no host at all is already true and should stay true.
- **The security model.** Loopback, ephemeral port, per-process token, descriptor
  beside the account file, no token in the page.

## What changes for the person using it

**Changed by step 1.** The browser no longer needs someone to start Hook first: it
launches one, and the page says "Starting Hook…" for the second that takes
(`hook.html`'s `#boot`, `panel.html`'s `.dock-boot`). A launch that fails is a
sentence on the card — "Hook's host is not installed on this computer", "would not
start", "is starting, but it has not published its channel" — instead of the old
"Hook is not running on this computer, and the browser cannot sign in on its own".

**Changed by steps 2–3.** The card's failures are now about the browser's own
host ("Hook's host is not installed on this computer", "would not start", "is
starting, but it has not published its channel"), and the dock reads the
browser's own folder: a browser with no Hook app installed has its own history,
which meets the account by syncing like any other product's. A machine that also
runs Hook keeps both — each publishes its own descriptor (step 4).

## Order of work

| | Work | Size | Gives |
| --- | --- | --- | --- |
| 1 | Browser launches `hook.exe --headless` (chat product) when no host answers; pid-checked; `--hook-no-host` | ~1 session | the browser starting its own process — **done** |
| 2 | `EventSink` + tokio handles, so the backend runs without `AppHandle` | 1–2 sessions | the hard half of the refactor, testable in `cargo test` — **done** |
| 3 | The `hook-host` binary, no Tauri, `Product::Browser`, `app.hook.browser` | 1–2 sessions | the browser as a product, syncing its own folder — **done** |
| 4 | Per-product descriptor files, and the fallback reads | ½ session | two products can run at once — **done** |
| 5 | Package it: copy beside `chrome.exe`, `scripts/products.mjs` hash, MSIX, release | with the shipping work | one installer, one browser, no other product needed |

Step 1 is deliberately shippable on its own and is what `--headless` was built
for; it can be replaced by the refactor without touching the page. It is in, so
the page, the transport and the routes below are the contract steps 2–4 must keep.

## Open decisions

- ~~**Kill with the browser, or outlive it?**~~ Kill, for the first version — step
  1 terminates the child on an orderly exit, and a survivor is reused rather than
  duplicated.
- **Does the browser host sync by default?** With its own folder, yes, or its
  chats never meet the account — but a local-only browser is a coherent
  privacy stance and the sync switch already exists per account. As built, it
  follows the account: a free account never reaches the network, and the
  account-wide switch turns it off for every product at once.
- ~~**What does the browser do when a chat host is also running?**~~ Step 1's
  answer: it uses whichever channel answers and launches nothing, so an app in
  the tray serves the browser until it quits. The browser's own host and the
  per-product descriptor (step 4) replace that coincidence.
- **Version coupling.** The host speaks the channel, so the browser and the host
  can version separately as long as the routes are append-only; a missing route
  must read as "this host is too old", not as a broken turn.
- **Windows first, again.** macOS would need the same binary in the app bundle;
  Linux is not a target.
