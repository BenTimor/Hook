# Hook

A local, single-provider AI chat app. Tauri 2 (Rust) + React 19 + TypeScript.

One provider, one model, one thinking level — baked in at build time. No login,
no settings screen, no account. Just a fast chat window with a sidebar full of
your own conversations.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Hook                    │  Chat title                  —   □   ✕      │
├─────────────┬────────────────────────────────────────────────────────┤
│ + New chat  │                                                        │
│ ⌕ Search    │                 Good afternoon                         │
│             │                                                        │
│ PINNED      │     ╭──────────────────────────────────────────╮        │
│  ⌖ Auth     │     │ Ask anything…                            │        │
│ TODAY       │     │                                     ( ↑ ) │        │
│  Sidebar    │     ╰──────────────────────────────────────────╯        │
└─────────────┴────────────────────────────────────────────────────────┘
```

## Configure

Everything lives in **`harness.config.toml`** at the repo root. It is compiled
into the binary with `include_str!`, so there is no way to change it at runtime:

```toml
[provider]
base_url = "https://api.openai.com/v1"   # any OpenAI-compatible endpoint
path = "/chat/completions"
api_key  = "sk-...-your-key"             # hard-coded into the build
reasoning_param = "reasoning_effort"     # or "reasoning", or "none"
stream_usage = true

[model]
name = "gpt-5.1"
thinking = "medium"                      # off | minimal | low | medium | high
```

`thinking` is sent to the provider using `reasoning_param` (mapped to
`reasoning_effort` for OpenAI-style APIs). It is never shown in the UI.

> The key ends up inside the executable. asar/bytecode/obfuscation do not change
> that. For a personal machine that is fine; if the key ever becomes valuable,
> put a small proxy in front of the provider instead.

## Run

Prerequisites: Node 20+, Rust stable (MSVC toolchain), WebView2 runtime.

```bash
cp harness.config.example.toml harness.config.toml   # then fill in your provider
pnpm install
pnpm app          # dev window with hot reload
```

The config file must exist before building — it is compiled into the binary, so a
missing file is a compile error by design.

No API key yet? Use the bundled mock provider:

```bash
cp harness.config.mock.toml harness.config.toml
pnpm mock         # terminal 1 — fake OpenAI-compatible endpoint on :8787
pnpm app          # terminal 2
```

Restore your real config afterwards (`cp harness.config.example.toml harness.config.toml`).

## Build

```bash
pnpm app:build     # NSIS installer + Hook.exe in src-tauri/target/release/
pnpm app:portable  # just the standalone Hook.exe (portable)
```

Outputs:

- `release/Hook-0.1.0-setup.exe` — installer (also in `src-tauri/target/release/bundle/nsis/`)
- `release/Hook-0.1.0-portable.exe` — standalone, no install (also in `src-tauri/target/release/`)

## Where the data lives

`%APPDATA%\app.hook.chat\chats\<id>.json` — one readable JSON file per
conversation, plus `trash/` for undoable deletions. No database, no sync, no
telemetry. Deleting the folder resets the app.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ + N` | New chat |
| `Ctrl/⌘ + K` | Search chats |
| `Ctrl/⌘ + B` | Toggle sidebar |
| `Enter` | Send |
| `Shift + Enter` | New line |
| `Esc` | Stop generating |
| Double-click a title | Rename |

## How it is put together

```
src-tauri/src/
  config.rs     include_str! the TOML, expose typed config
  provider.rs   OpenAI-compatible SSE client (byte-buffered, cancellable)
  store.rs      atomic JSON persistence, pin/delete/restore/search
  commands.rs   the IPC surface (streams over tauri::ipc::Channel)
src/
  lib/bridge.ts  typed invoke wrappers; falls back to dev/mock.ts in a browser
  store/         zustand: chats, messages, per-chat token buffers
  components/    Sidebar, Thread, Composer, Markdown, CodeBlock…
  styles/        design tokens, glass surfaces, prose styles
```

Details worth knowing:

- **The renderer never sees the key.** All network calls happen in Rust.
- **Streaming** goes through a `Channel<StreamEvent>`; deltas are coalesced per
  animation frame in the store so React re-renders at most ~60×/s.
- **Cancellation** is cooperative (`CancelToken` → `tokio::select!`), so a
  stopped reply is still persisted with its partial text and `aborted` status.
- **Persistence** is atomic (write temp file, then rename), so a crash can't
  leave a half-written chat.
- **Window chrome** is frameless with a custom titlebar and native rounded
  corners. The glass surfaces (sidebar, composer) are pure CSS — no dependency
  on OS backdrop materials, so it looks the same on every machine.

## Tests

```bash
cd src-tauri
cargo test                 # pure logic: SSE framing, UTF-8 splits, config
cargo test --lib -- --ignored   # live tests against `pnpm mock`
```
