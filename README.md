# Hook

A local, single-provider AI chat app. Tauri 2 (Rust) + React 19 + TypeScript.

One provider, one model, one thinking level — baked in at build time. No login,
no account, no provider screen. Just a fast chat window with a sidebar full of
your own conversations — and a chat agent that can put real coding work in
motion inside your own project folders.

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

Coding agents and the chat agent's instructions have their own optional
sections:

```toml
[coding]
model = ""            # passed to pi as --model; empty = pi's default
thinking = ""         # passed to pi as --thinking
max_concurrent = 3    # how many coding agents may run at once
bash_max_timeout = 3600   # seconds, enforced on every bash call
bash_min_timeout = 1

[agent]
system_prompt = ""    # empty = Hook's built-in instructions
```

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

```
%APPDATA%\app.hook.chat\
  chats\<id>.json          one readable JSON file per conversation
  trash\                   undoable deletions
  settings.json            projects folder, pi path
  projects.json            the notes the chat agent keeps about projects
  agents.json              coding-agent runs and their states
  agent-sessions\          pi session files (resumable)
  hook-guard.mjs           the guard loaded into every coding agent
```

No database, no sync, no telemetry. Deleting the folder resets the app.

## Coding agents

The chat agent can create projects, brief a coding agent, and report back in the
conversation while you keep chatting.

- **Projects** live in one folder (default `~/Documents/Hook`), configured in the
  Settings sheet. Every chat can use every project. Each project carries a short
  description the chat agent maintains — that description is how it finds the
  right project later.
- **The chat agent never touches files.** Its tools are `list_projects`,
  `create_project`, `update_project_description`, `start_coding_agent`,
  `list_agents`, `agent_status`, `steer_agent`, `answer_agent`, `stop_agent` and
  `list_coding_sessions`. All code reading and editing happens inside a coding
  agent.
- **Coding agents are pi subprocesses**, driven over `--mode rpc` with the
  project folder as their working directory:

  ```
  pi --mode rpc --session-dir <appdata>/agent-sessions --session-id <id>
     --name "<title>" -ne -e hook-guard.mjs -ns -np --no-mcp -na
  ```

  Those flags keep them isolated: your own extensions, skills, prompt templates,
  MCP servers and project-local pi config are ignored, so an agent behaves the
  same on any machine that has pi. Your pi auth and model selection still apply.
- **The guard is the only policy they inherit.** Every `bash` call must carry a
  `timeout` in seconds (1–3600 by default). Missing, oversized or non-numeric
  timeouts are blocked with an explanation, and the model re-issues the call.
  Tune it with `bash_max_timeout` / `bash_min_timeout`.
- **They run asynchronously.** `start_coding_agent` returns immediately and you
  can keep talking. When an agent settles, fails, or asks a question, Hook
  appends a hidden note to the owning chat and wakes the chat agent, which posts
  an update in its own words. If the chat agent is mid-turn, the wake waits.
- **You never see the agents.** A quiet pill in the title bar says that a coding
  agent is working — no list, no log, no session browser. Everything you learn
  comes from the chat agent.
- **Sessions are resumable.** They live in
  `%APPDATA%\app.hook.chat\agent-sessions\`. A finished agent — or one that
  was cut off when Hook closed — can be continued by session id.

Agents are children of Hook: closing the window kills their process trees and
marks the run `interrupted`, so nothing keeps running behind your back.

The Settings sheet (gear in the sidebar footer) holds exactly two things: the
projects folder and the pi executable. Provider and model settings stay compiled
into the build.

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
  provider.rs   OpenAI-compatible SSE client + streamed tool_calls
  store.rs      atomic JSON persistence, pin/delete/restore/search
  turn.rs       the assistant turn: model → tools → tools → answer, plus wakes
  tools.rs      the tool schemas and their implementations
  agent.rs      pi RPC supervisor: spawn, state machine, steer/answer/stop
  guard.rs      the guard extension, materialized from the binary
  settings.rs   projects folder + pi discovery
  projects.rs   folder scanning, descriptions, path containment
  commands.rs   the IPC surface
src/
  lib/bridge.ts  typed invoke wrappers + app-wide event bus
  store/         zustand: chats, per-chat streams, agents, settings
  components/    Sidebar, Thread, Composer, SettingsSheet, AgentPill…
  styles/        design tokens, glass surfaces, prose styles
```

Details worth knowing:

- **The renderer never sees the key.** All network calls happen in Rust.
- **Streaming** arrives on one app-wide `hook://chat` event (user turns and
  agent-woken turns alike); deltas are coalesced per animation frame in the store
  so React re-renders at most ~60×/s, and several chats can stream at once.
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
cargo test                      # unit tests + two zero-cost integration checks
cargo test --lib -- --ignored   # live tests against `pnpm mock`
```

`cargo test` covers SSE framing, UTF-8 splits, path containment, the project and
agent stores, the chat-agent tool loop, the guard policy (a Node harness feeds it
bad `bash` calls), the pi RPC handshake (spawns the real pi, asks `get_state`,
never calls a model) and a full agent lifecycle against a fake pi that speaks the
RPC protocol. Tests skip themselves when `pi` or `node` is missing.
