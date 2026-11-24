# Hook Browser — its own host process

> **Status: design only.** Nothing here is built. Today the browser starts no
> process at all, and `hook --headless` is the interim host a person (or a
> shortcut) starts by hand. This document is the answer to "can the browser work
> by itself, without another product's daemon, and what does it cost".

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

So the honest statement today is: the browser needs *a* Hook process, any product
will do, and the content depends on which one it is. That is a coincidence of
where the channel was put, not a design.

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

Today's `--headless` is the Tauri app with its window hidden: it still creates a
webview, still carries Wry and the window resources, and is compiled for
`Product::Chat`. The real host is a plain Rust binary:

- `hook-core`'s stores, `auth.rs`, `sync.rs`, `turn.rs`, `tools.rs`, the channel
  — everything but `lib.rs`'s Tauri builder.
- No webview, no tray, no window, no plugins it does not use. Expect roughly the
  size of the desktop backend without the window stack.
- It writes `browser-channel.json` (`Channel::serve` already does) and runs until
  it is asked to stop.

One refactor is the price of admission: **`AppState` is built around
`AppHandle`**. Event emission (`emit_auth`, `emit_chat`, the sync and preview
events) and `tauri::async_runtime::spawn` are used across `commands.rs`,
`turn.rs`, `sync.rs` and `coding.rs`. Replace the emission with a small trait —

```rust
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: serde_json::Value);
}
```

— with the Tauri app implementing it over `AppHandle::emit` and the host
implementing it as a no-op (or a log line). The spawns become a tokio handle the
host owns. `ChannelBackend` does not change, and neither do the routes.

## Starting it

The browser starts the host, on demand, once per browser run:

1. `HookChannel::Check()` fails **and** no descriptor exists → launch the host
   with `base::LaunchProcess` (no shell), from a **fixed path** resolved at build
   time (beside `chrome.exe`; the dev tree points at the repository's build). A
   path that comes from a page, a preference or an environment variable is not
   something the browser may execute.
2. Wait for the descriptor and require its `pid` to be the child's. A descriptor
   written by another product is not ours to use, and a stale one must not send
   the browser to a dead port.
3. `--hook-no-host` disables the launch entirely, so the signed-out card and the
   smoke (`--signin-state out`) can still be proven without a host.
4. Never during `--hook-signin-state=in|out`: those are test seams, and a test run
   must not leave processes behind.

Exit policy is a decision, not a detail:

- **Kill with its browser** keeps the machine clean and makes the host an
  implementation detail, but a turn still streaming when the window closes dies
  with it.
- **Outlive the browser** lets a long turn finish and lets the next window reuse
  the host; it needs the stale-descriptor reaping the channel already implies
  (a descriptor whose pid is gone reads as "not running").

The channel's `Check()` is already that reaper — the descriptor's `pid` is written
today (`Channel::write_descriptor`), so both policies are cheap. The recommendation
is kill-on-exit for the first version: one browser, one host, no orphans, and the
turn is a foreground action.

## The descriptor becomes per product

`browser-channel.json` is one file in a folder every product shares, so the last
process to start wins it. Two products running (the app in the tray, the
browser's own host) is the normal case once the browser is a product, and they
must not fight over the name.

Change it to `browser-channel.<product>.json` — `browser-channel.chat.json`,
`browser-channel.browser.json` — written by `Channel::serve` from the backend's
`product()`. The browser reads its own product's file first and falls back to the
other names (a browser with no host of its own can still use a running app, which
is today's behaviour and a useful safety net during the transition).

## What does not change

- **The page.** `browser/ui/transport.ts` is a `ChatTransport` over mojom; the
  routes behind it are the same. Sign-in stays `StartSignIn` → `/auth/start` →
  poll `GetSignIn` → reload.
- **The gate.** It reads the account file, not the channel. That the browser can
  browse with no host at all is already true and should stay true.
- **The security model.** Loopback, ephemeral port, per-process token, descriptor
  beside the account file, no token in the page.

## What changes for the person using it

The signed-out card stops saying "Hook is not running on this computer". With its
own host, the browser starts one and shows the device code; the "start Hook first"
branch becomes the fallback for a broken or missing install, not the normal state.
The dock stops saying "Hook is not running" for the same reason.

## Order of work

| | Work | Size | Gives |
| --- | --- | --- | --- |
| 1 | Browser launches `hook.exe --headless` (chat product) when no host answers; pid-checked; `--hook-no-host` | ~1 session | the browser starting its own process, today |
| 2 | `EventSink` + tokio handles, so the backend runs without `AppHandle` | 1–2 sessions | the hard half of the refactor, testable in `cargo test` |
| 3 | The `hook-host` binary, no Tauri, `Product::Browser`, `app.hook.browser` | 1–2 sessions | the browser as a product, syncing its own folder |
| 4 | Per-product descriptor files, and the fallback reads | ½ session | two products can run at once |
| 5 | Package it: copy beside `chrome.exe`, `scripts/products.mjs` hash, MSIX, release | with the shipping work | one installer, one browser, no other product needed |

Step 1 is deliberately shippable on its own and is what `--headless` was built
for; it can land before the refactor and be replaced by it without touching the
page.

## Open decisions

- **Kill with the browser, or outlive it?** Recommended: kill, first version.
- **Does the browser host sync by default?** With its own folder, yes, or its
  chats never meet the account — but a local-only browser is a coherent
  privacy stance and the sync switch already exists per account.
- **What does the browser do when a chat host is also running?** Use its own;
  fall back to the other products' descriptors only while step 1 is the state.
- **Version coupling.** The host speaks the channel, so the browser and the host
  can version separately as long as the routes are append-only; a missing route
  must read as "this host is too old", not as a broken turn.
- **Windows first, again.** macOS would need the same binary in the app bundle;
  Linux is not a target.
