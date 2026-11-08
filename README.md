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
tools = true                             # offer the agent tools to the model
reasoning_echo = "auto"                  # replay reasoning on tool turns

[model]
name = "gpt-5.1"
thinking = "medium"                      # off | minimal | low | medium | high
```

`thinking` is sent to the provider using `reasoning_param` (mapped to
`reasoning_effort` for OpenAI-style APIs). It is never shown in the UI.

Thinking-mode APIs (DeepSeek among them) reject the follow-up request unless the
assistant's `reasoning_content` is replayed on tool-calling turns — an empty
string counts. Hook records the field each answer was streamed in and sends it
back automatically (`reasoning_echo = "auto"`); set it to `"off"` or to an
explicit field name if your provider wants something else.

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
pnpm engine        # fetch the coding engine into src-tauri/resources/pi-runtime
pnpm app:build     # NSIS installer (runs `pnpm engine` first)
pnpm app:portable  # portable folder, zipped (runs `pnpm engine` first)
```

Outputs:

- `release/Hook-0.1.0-setup.exe` — installer, ~28 MB (also in `src-tauri/target/release/bundle/nsis/`)
- `release/Hook-0.1.0-portable.zip` — `Hook.exe` + `resources\pi-runtime`, no install

The engine (Node + pi) is ~104 MB of binaries and is not in git; `pnpm engine`
copies it from the pi package on this machine. `scripts/fetch-pi-runtime.mjs`
also proves the copy can load Hook's guard before anything gets packaged.

## Where the data lives

```
%APPDATA%\app.hook.chat\
  chats\<id>.json          one readable JSON file per conversation
  trash\                   undoable deletions
  images\<chat id>\        pictures attached to messages (bytes on disk)
  settings.json            projects folder
  projects.json            the notes the chat agent keeps about projects
  agents.json              coding-agent runs and their states
  agent-sessions\          coding-engine session files (resumable)
  agent-home\              the engine's own config: models.json (this build's
                           endpoint + key + model), settings.json, sessions
  updates\<agent id>\      progress notes the agents wrote, collected each second
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
- **Hook ships its own engine.** The installer carries a Node runtime and the
  pi coding agent's bundle as app resources; agents run on that copy. Nothing is
  installed on the machine, nothing is looked up on `PATH`, and there is no
  setting for it anywhere in the UI.
- **Coding agents are pi subprocesses**, driven over `--mode rpc` with the
  project folder as their working directory:

  ```
  <resources>/node.exe <resources>/pi/dist/bundle/cli.js --mode rpc
     --session-dir <appdata>/agent-sessions --session-id <id> --name "<title>"
     -ne -e hook-guard.mjs -ns -np --no-mcp -na --model hook/<model>
  ```

  `PI_CODING_AGENT_DIR` points at `%APPDATA%\app.hook.chat\agent-home`, whose
  `models.json` is rewritten from `harness.config.toml` on every launch. So an
  agent uses exactly the chat agent's endpoint, key, model and thinking level,
  and never touches your own `~/.pi` — different extensions, skills, MCP servers
  and logins on your machine cannot change what it does.
- **Progress updates — only when there is news.** Agents get one extra tool,
  `report_progress(note, images?)` and are told to use it for milestones,
  decisions, problems and the final result, never as a heartbeat: "still
  working" is explicitly off-limits, and long silences are expected. Notes go
  into a mailbox Hook watches; Hook batches them (at most one batch a minute,
  immediately on finish/fail/question) and hands the chat agent a note. The chat
  agent may answer `no_update`, which drops the message entirely — a batch that
  says nothing worth reading produces nothing in the chat. A quiet job can go
  from start to finish with a single update, or none until the result. Pictures
  travel with the message the chat agent writes, so an update reads like "here
  is the menu as it stands" with the screenshot right there. How an agent
  produces them is up to it: a headless browser, the project's own harness, an
  engine's screenshot API.
- **Output budget.** `[coding] max_output_tokens` (32k) is the per-turn ceiling.
  Raise it for long autonomous runs; lower it to cap cost. The chat agent's own
  `[model] max_tokens` is separate.
- **Pictures from you.** Paste, drag or pick an image in the composer. Bytes are
  downscaled and stored on disk, not in the chat JSON. If `[provider] vision` is
  on, they reach the model as image parts; if not (or if the endpoint rejects
  them) they stay visible to you and are described in text.
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

The Settings sheet (gear in the sidebar footer) holds one thing: the projects
folder. Provider and model settings — and everything about the coding engine —
stay compiled into the build.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ + N` | New chat |
| `Ctrl/⌘ + K` | Search chats |
| `Ctrl/⌘ + B` | Toggle sidebar |
| `Ctrl/⌘ + V` | Paste an image into the composer |
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
  agent.rs      engine RPC supervisor: spawn, states, progress batching, wakes
  runtime.rs    locate the bundled engine, write its models.json
  guard.rs      the guard extension, materialized from the binary
  settings.rs   projects folder
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

`cargo test` covers SSE framing, UTF-8 splits, reasoning echo (the exact request
shapes thinking-mode APIs reject), image parts and the base64/header helpers,
path containment, the project and agent stores, progress batching, the chat-agent
tool loop, the guard policy (a Node harness feeds it bad `bash` calls), the RPC
handshake (spawns the real engine, asks `get_state`, never calls a model) and a
full agent lifecycle against a fake one that speaks the protocol. Tests skip
themselves when the engine or `node` is missing.

## A note on packaged builds

Two things only break in an installed app, never in `tauri dev`:

- Tauri hands out resource paths with the Windows `\?\` prefix. Node cannot load
  a script through one, so `runtime.rs` strips it before spawning (`strip_verbatim`).
- Resources are mapped with a directory rule (`"resources/pi-runtime": "pi-runtime"`).
  A `**/*` glob flattens the tree and the engine loses `pi/dist/bundle/cli.js`.

Both are covered by tests, and the portable zip is verified with
`src-tauri/resources/pi-runtime` moved aside so the dev copy cannot mask a
packaging bug. Agents write their stderr to `%APPDATA%\app.hook.chat\logs\`.
