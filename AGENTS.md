# AGENTS.md

Onboarding for coding agents working on Hook. If your change makes a line here
wrong, fix it in the same commit.

## Commit and push only when asked

Work is finished when the files are edited and the checks pass, not when it is
pushed. Stop there and report what changed.

- Commit only when the user asks for a commit. Push only when the user asks for a
  push in that same message — "commit" is not a push, and "looks good" is not
  either.
- Do not run `pnpm version:bump` unless asked: a bump is the first step of a
  release, not part of a code change.
- Do not push to `main` to "see if CI passes". A push to `main` deploys
  hookcode.io and can publish a Windows installer for both products, and every
  run costs twenty-plus minutes of build minutes.

## What this is

Hook is an ecosystem of local-first desktop products that share one account, one
design system and one backend. Tauri 2 (Rust) + React 19 + TypeScript, in a
single pnpm + Cargo workspace.

| Product | Code | Dev | Build | Deploy |
| --- | --- | --- | --- | --- |
| **Hook** (AI chat + coding agents) | `apps/chat/` | `pnpm app` | `pnpm app:build` / `pnpm app:portable` | `pnpm release` |
| **Hook Workspace** (projects, boards, tasks, docs) | `apps/workspace/` | `pnpm workspace:app` | `pnpm workspace:app:build` | `pnpm release` |
| **HookCode** (phone: chat + Workspace, no coding agents) | `apps/mobile/` | `pnpm mobile:android` / `pnpm mobile:ios` | `pnpm mobile:build` | App Store Connect / Play Console |
| Landing page | `waitlist/` | `pnpm waitlist:dev` → :5173 | `pnpm waitlist:build` → `dist-waitlist/` | `.github/workflows/deploy-waitlist.yml` |
| Account service | `server/` | `pnpm waitlist:start` | Docker image | `scripts/deploy-waitlist.sh` |

Shared, and the reason the products look and behave alike:

```
crates/hook-core/    the backend every product links: account, chats + sync,
                     coding agents, preview, the assistant turn, the IPC surface
packages/ui/         tokens.css, window chrome, buttons/inputs, dialogs, the mark
packages/chat/       the chat surface: Markdown, CodeBlock, Thread, MessageItem,
                     Composer, and the ChatDock panel every product embeds
packages/chat/src/preview/
                     the Hook Workspace preview: a board, a task and a document,
                     drawn from the JSON `workspace_preview` returns. The
                     desktop puts it in its side panel, the phone in a sheet.
```

`server/` and `waitlist/` deliberately stay at the repo root: they are one deploy
unit (one container, one `/data` volume) that every product talks to, not an app
you build alongside the others.

## Commands

```bash
# Desktop apps
pnpm install                     # once: with missing links tsc blames a source
                                 # file (TS2307) instead of node_modules
cp harness.config.ci.toml harness.config.toml  # required before any cargo build
pnpm dev                          # chat UI in a plain browser (mock backend)
pnpm app                          # chat product: real Tauri window, hot reload
pnpm workspace:dev                # Workspace UI in a plain browser
pnpm workspace:app                # Workspace: real Tauri window
pnpm mobile:dev                   # phone UI in a plain browser (mock backend)
pnpm mobile:android               # phone product on an emulator or device
pnpm mobile:ios                   # phone product on a simulator (macOS, Xcode)
pnpm typecheck                    # every package + the landing page (the only static gate)
pnpm app:build                    # chat NSIS installer (fetches engine + git first)
pnpm workspace:app:build          # Workspace NSIS installer
pnpm version:bump patch           # patch|minor|major, add --product workspace
pnpm release                      # build + publish installers (-- --dry-run, -- --store)
cargo test                        # whole workspace, at the repo root; no engine or network
cargo test -p hook-core -- --ignored   # live tests; run `pnpm mock` first

# Landing page + account service
pnpm waitlist:dev
pnpm waitlist:test                # API, device login, proxy, download, sync, git
pnpm waitlist:build

# Release pipeline (Node only)
pnpm test:release

# Bundled git and coding engine (pinned; ~93 MB and ~104 MB per app)
pnpm git
pnpm engine

# Offline chat against a fake OpenAI-compatible endpoint on :8787
pnpm mock
```

No ESLint, Prettier or rustfmt config. Match the file you are editing.

Commands run under bash on Windows, not `cmd.exe`, so redirect to
`/dev/null` and never `>nul`. `nul` is the null device in `cmd.exe` only; from
bash it creates a file named `nul` in the working directory, and `nul` is a
reserved device name on Windows. A stray `nul` at the repo root is that
mistake: delete it, never commit it.

**Never kill processes by image name.** `taskkill /F /IM node.exe /T`,
`pkill -f node` or `Stop-Process -Name node` matches every Node process on the
machine — the dev servers, the desktop app, and the coding agent (or whatever
harness) you are running inside. Killing your own process tree ends the task
mid-command and can leave a dev server, a lockfile or a half-written build
behind. Stop the process you actually started: run it with a PID you kept
(`cmd & echo $!`), or kill the port it owns
(`netstat -ano | grep :1420`, then `taskkill //F //PID <pid>`). This is the same
class of mistake as `>nul`: a Windows habit that is silently destructive from
bash.

## Where things live

- `crates/hook-core/src/turn.rs` — the assistant turn (model → tools → answer),
  the system prompt, streaming and cancellation. Largest, most delicate file.
  Its request is **append-only**: the leading system message is the instructions
  and nothing else, and everything volatile (coding-agent notes, memory frames,
  the live hint, window context) is a message appended after it. See
  "Never rewrite the request prefix" below before touching `system_message`,
  `build_history` or `ensure_memory_frames`.
- `crates/hook-core/src/memory.rs` — what the chat agent remembers between
  conversations: entries (text, kind, pin, source chat), the pinned block, the
  frames that carry it into a chat, `memory_search`, and per-account files in
  the shared `%APPDATA%\app.hook\memory\` folder.
- `crates/hook-core/src/tools.rs` — chat-agent tool schemas and implementations.
- `crates/hook-core/src/agent.rs` — supervisor for `pi` subprocesses over RPC:
  spawn, states, plans, progress batching, wakes, stop. It also points agents at
  the bundled git and the managed `agent-home/gitconfig`. `transcript()` reads a
  run's pi session file (plus an in-memory tail from `message_update`) for the
  advanced inspector; it is read-only.
- `crates/hook-core/src/lib.rs` — `Product`, `Capabilities`, and the Tauri
  builder every product calls. A capability trims the prompt and the toolset; it
  must never change the data model. The five fields are places an answer can
  appear or things a device can reach: `preview_pages` (an HTML file served from
  a project), `preview_workspace` (a board, task or document — just account
  data), `coding_agents`, `workspace_tools`, `projects` (a folder on this
  machine). `Capabilities::mobile()` is the phone: Workspace yes, folder no.
- `crates/hook-core/src/auth.rs` — device flow, the shared
  `%APPDATA%\app.hook\account.json`, per-product mirrors, git-token rotation.
- `crates/hook-core/src/{store,sync}.rs` — chats on disk and the background
  sync engine (cursor, pending queue, account quarantine, media).
  `ChatMeta.kind = "coding"` marks a chat the user has with a coding agent
  directly: it carries `projectPath` and `sessionId`, and it is never uploaded.
- `crates/hook-core/src/coding.rs` — that chat's turn driver: start / steer /
  answer / stop the engine, and turn its RPC records (`message_start`,
  `message_update`, `message_end`, `tool_execution_end`, `agent_settled`,
  `agent_exit`) back into the `Message` list the thread already draws. It owns
  the assistant message being streamed, so nothing else has to know that a
  direct conversation is not a model turn.
- `crates/hook-core/src/bridge.rs` — the loopback endpoint that runs the chat
  agent's own tools (projects, memory, Workspace) for a directly-driven agent.
  One token per chat, only the tool names written into that agent's
  `tools.json`, and the schemas come from `tools::direct_bridge_definitions`.
- `crates/hook-core/src/{git,projects}.rs` — bundled MinGit, scoped git config,
  project folders and their account ids. "Project" here means a **code project**,
  a folder on disk; Workspace projects are a different thing (`ws_` ids).
  Both Git launch paths use the same command builder to keep background
  commands from opening a console in Windows desktop builds.
- `crates/hook-core/src/{preview,runtime,guard}.rs` — loopback preview server,
  engine lookup, and the guard extension (`resources/hook-guard.mjs`, embedded
  with `include_str!`; edit the `.mjs`).
- `crates/hook-core/src/{provider,import,update,reports}.rs` — SSE client, the
  ChatGPT/Claude export readers, the release index and update policy, AI reports.
- `crates/hook-core/src/commands.rs` — the whole IPC surface.
- `packages/chat/src/{Thread,MessageItem,TurnActivity,Composer}.tsx` — the
  conversation and the input, prop-driven and store-free. `TurnActivity` is the
  line that says what a running turn is doing ("Thinking…", "Searching the web
  for …"); the store hands it the labels and it owns the pacing. In advanced
  mode `Thread` groups each turn's thinking and tool calls into one fold above
  the answer (`turns.ts`), drawn by `WorkSteps.tsx`, so the conversation and the
  coding-agent inspector share one renderer. `apps/chat/src/
  components/{Thread,Composer}.tsx` are the thin store adapters; a product
  supplies the pictures (`renderExtras`) and what Report means (`onReport`).
  `apps/chat/src/components/{AgentTree,AgentInspector}.tsx` are the sidebar tree
  and the read-only transcript drawer. `chat.css` holds their styles and
  `dock.css` the 380px overrides, so both apps look the same.
- `packages/chat/src/ChatDock.tsx` — the collapsible chat panel every product
  embeds, built from those same pieces. It takes a `ChatTransport`, so it knows
  nothing about which app it is running in;
  `apps/workspace/src/lib/chatTransport.ts` is that adapter.
- `packages/chat/src/preview/` — `WorkspacePreview` and its three renderers,
  `reportableFrom` and `ReportContentDialog`. The JSON is what
  `workspace_preview` returned; the components own no frame, so `PreviewPanel`
  (desktop, side panel) and `apps/mobile/src/components/PreviewSheet.tsx`
  (phone, bottom sheet) draw the same thing. A task's comments are other
  people's words: that is what `ReportContentDialog` is for, not the AI report.
- `packages/chat/src/images/` — the picture strip and its lightbox. A product
  supplies `load`, the only part that knows where the bytes are; `onOpen` and
  `onSaveAs` are optional, so a phone draws neither button. The chat window
  reads from the chat's image folder, the phone from the same folder inside its
  own container.
- `apps/mobile/` — HookCode on a phone. Two screens (list, thread), two sheets
  (preview, settings) and `mobile.css`, which is the phone's re-skin of the
  shared surface the way `dock.css` is the 380px one. `src-tauri` passes
  `Product::Mobile` + `Capabilities::mobile()`; there are no agents, no folder
  picker and no installer, and `scripts/release.sh` does not build it.
- `apps/chat/src/lib/bridge.ts` — typed `invoke` wrappers and app-wide events
  (`hook://chat`, `hook://agents`, `hook://preview`, `hook://auth`,
  `hook://sync`, `hook://import`, `hook://update`).
- `apps/chat/src/store/useChatStore.ts` — all chat state; coalesces stream deltas.
- `apps/workspace/src/components/WorkspaceHome.tsx` — invitations, projects and
  getting-started actions. `InvitationCard.tsx` shares response states with the
  Invites inbox; sender profiles are optional fields from `GET /api/ws/invites`.
- `apps/workspace/src/lib/documentImages.ts` — validates image sources and
  sizes images added by the toolbar, clipboard or file drop in the Markdown
  editor shared by documents and tasks.
- `packages/ui/src/tokens.css` — the design foundation (tokens, base elements,
  window chrome, prose, buttons/inputs). Both products import it first.
- `waitlist/content.json` — all landing-page copy and interest definitions.
- `server/platform.mjs` — mounts waitlist, device login, download, sync, git and
  the model proxy under `/api`.
- `server/workspace.mjs` — Workspace projects/boards/tasks/documents/members.
- `infra/` — reference server config, uploaded by `scripts/deploy-waitlist.sh`.
- `release.config.json` — per-product minimum versions and the Store channel.
- `msix/<product>/` — Partner Center identity + manifest template per product.
- `scripts/products.mjs` — what a product is and what its source hash covers.
- `scripts/build-msix.mjs`, `scripts/make-portable.mjs` — take `--product <id>`.
- `scripts/fetch-git.mjs`, `scripts/fetch-pi-runtime.mjs` — take an app dir.
- `scripts/app-source-hash.mjs` — a product's installer inputs (shared packages
  included, so a change in `packages/*` invalidates every product). Tests are
  excluded: they run in CI but never enter an executable.
- `scripts/site-source-hash.mjs` — what the server container runs, so a deploy
  that only changes the site skips the Docker rebuild.
- `scripts/release.sh` — `pnpm release`: refuses a dirty or unpushed tree, runs
  the checks, builds each changed product, publishes the installer and the index.
- `scripts/release-gate.mjs` — decides whether a product's source is already
  published (and refuses a missing version bump).
- `scripts/merge-release-index.mjs` — folds a build into `releases.json`.

## Touch every layer

Changing one side of a boundary is the most common way to break this repo.

- **New IPC command:** `crates/hook-core/src/commands.rs` → `generate_handler!` in
  `crates/hook-core/src/lib.rs` → the product's `bridge.ts` wrapper → `types.ts`
  → the `mock.ts` fallback → store/component. Both `isTauri()` branches must work.
  A command that only the phone has still goes in `hook-core` (it is the same
  account code) and its `Capabilities` decide whether the prompt mentions it.
- **Native sign-in:** `plugins/google-signin` (Kotlin Credential Manager +
  `register_android_plugin` in its `lib.rs`) → `apps/mobile/src/lib/api.ts` →
  `POST /api/auth/config` and `POST /api/auth/google` in `server/auth.mjs` → the
  same `api_tokens` row the device flow writes. The Android OAuth client
  (package `app.hook.mobile` + the SHA-1 of the signing key) must exist in the
  same GCP project as the web client, or Google refuses to show the sheet; the
  server hands the client id to the app so nothing is baked into a build.
- **Chat surface change:** `packages/chat/src` (component + `chat.css`) → check
  it at both sizes (the chat window and the 380px dock) → the adapters in
  `apps/chat/src/components` if the store gains a prop. Never fork a component
  into one app: the dock and the window are meant to be the same thing. The
  activity line (`TurnActivity.tsx`, drawn by `Thread.tsx`) is the *empty*
  reply's place: a message that is merely streaming must not hide it, or a
  thinking model leaves a blank window for half a minute. Only text that is on
  screen counts as "arriving".
- **Advanced-mode change (thinking, tool calls, coding-agent inspector):**
  `settings.rs` (`advanced_mode`) → `commands.rs` (`set_advanced_mode`) →
  `bridge.ts` / `types.ts` / `mock.ts` → the settings in the store →
  `Thread showDetails` → `packages/chat/src/turns.ts` and `WorkSteps.tsx`.
  The agent half is `agent.rs::transcript` + `commands::agent_transcript` →
  `AgentInspector.tsx`; live thinking comes from the `message_update` records
  that are otherwise skipped. Hidden messages and tool results must stay in
  history and be filtered only at render time — `visible()` in the store keeps
  them for exactly this reason.
- **Direct coding-agent chat (a conversation with `pi`, no chat agent):**
  `store.rs` (`KIND_CODING`, `is_local_only`) → `sync.rs::push_chats` (skip and
  clear it, so the status line is not stuck) → `agent.rs` (`direct` on
  `AgentInfo`, `start_direct`, no wakes, `Signal::Record`) → `coding.rs` →
  `commands.rs` (`create_coding_chat`, `set_coding_chat_folder`,
  `answer_coding_agent`, and the `coding` branches in `send_message`,
  `stop_stream`, `stop_chat_agents`) → `bridge.rs` + `tools.json` + the guard's
  `HOOK_DIRECT` branch → `bridge.ts` / `types.ts` / `mock.ts` →
  `useChatStore` (`newCodingChat`, `changeCodingFolder`, `answerAgent`) →
  `Sidebar` (the New chat menu and the advanced filter), `ChatRow`,
  `PaneHead`, `AgentBoard`, `Composer` (`steer`). Three filters matter: the
  sidebar hides these chats while Advanced is off, `setAdvancedMode` closes one
  that is already open (the simple view cannot fold its per-tool turns), and
  `AgentTree` skips `direct` runs; `apps/workspace`'s chat transport always
  filters them out.
  One trap: a direct run starts from `send_message`, a **synchronous** command,
  so everything on that path must use `tauri::async_runtime` (the driver spawn
  in `agent.rs` included) — a `tokio::spawn` there panics with "there is no
  reactor running" and aborts the window, because a panic in a command thread
  cannot unwind.
- **New chat-agent tool:** schema + impl in `tools.rs`, dispatch in `turn.rs`,
  and the prompt in `turn.rs` (`system_prompt`) if the agent must know about it.
  Give it a line in `activity_label` (`turn.rs`): that is what the chat says it
  is doing while the tool runs, and a test fails when an advertised tool has
  none. Gate it on `Capabilities` when only some products have it. A tool that
  reaches beyond `tools.rs` follows `workspace_*` (own `definitions()` +
  `execute`, added to the toolset in `run_turn`) or `memory::*` (the same, plus
  the Settings toggle).
- **New kind of memory, or a change to how it reaches a chat:**
  `memory.rs` (store, caps, frames) → `turn.rs` (`ensure_memory_frames`,
  `activity_label`, the `## Memory` prompt section) → the tool schemas in
  `memory.rs` → `commands.rs` + `generate_handler!` → `bridge.ts` → `types.ts` →
  `mock.ts` → `SettingsSheet.tsx` / `MemorySection.tsx` → `server/sync.mjs`
  (`/memory`, the `/changes` union) → `server/api.mjs` (`sync_memory`) →
  `server/sync.test.mjs`. Keep the frames append-only and the caps enforced;
  `pinned_budget_chars` is what stops memory from eating the prompt.
- **Project instructions for coding agents:** `projects.rs`
  (`append_agent_note` / `agent_notes`, the marked block in `AGENTS.md`) → the
  `remember_in_project` tool in `tools.rs` → the prompt's **Projects** section.
  Only the marked block is Hook's; never rewrite the rest of the file.
- **New product:** `apps/<id>/` (package.json, index.html, vite.config.ts,
  `src-tauri/` with its own identifier) → `Product` + `Capabilities` in
  `crates/hook-core/src/lib.rs`, plus its own version passed to
  `hook_core::builder(product, capabilities, env!("CARGO_PKG_VERSION"))` → an
  entry in `scripts/products.mjs` → root scripts → its own `msix/<id>/`. Every
  *desktop* product is built and published by
  `pnpm release` (`scripts/release.sh`); add its `package.json` to the manifest
  copies in `Dockerfile` so a workspace install still resolves. A product with
  `kind: "mobile"` is different on purpose: it needs
  `crate-type = ["staticlib", "cdylib", "rlib"]`, `tauri android init` /
  `tauri ios init` once, and it ships through App Store Connect and the Play
  Console. `scripts/release.sh` keeps its own list and does not build it.
  "Product" in this repo means a business product sharing the account — Hook,
  Hook Workspace, HookCode on a phone, and the future browser — not every
  `apps/*` directory.
- **New guard behavior:** `crates/hook-core/resources/hook-guard.mjs`, plus
  `tools.rs` if it calls back into Rust; then `crates/hook-core/tests/guard_policy.rs`
  + `tests/fixtures/guard-harness.mjs`. The guard may only import `node:*`
  built-ins — it is copied into the user's data folder where nothing resolves.
- **New import format:** a reader in `import.rs` returning `Parsed` (plus a unit
  test in that file) → `commands.rs` (`import_scan` / `import_apply`) →
  `generate_handler!` → `bridge.ts` / `types.ts` → `mock.ts` → `ImportSection.tsx`.
  Ids must stay derived from the source's own ids, or a re-import duplicates
  every conversation instead of updating it.
- **Sync identity rules:** project ids live in each product's `projects.json`,
  while both products open the same projects folder. Before changing
  `ProjectsStore::bind` or `push_projects`, know that a folder is the same
  project even when two windows call it by different ids: `bind` adopts the
  account's id for a folder it already owns, and a push that comes back
  `duplicate_name` adopts `conflictId` instead of retrying forever. One project
  the account refuses (a >64-character or reserved name) is skipped locally and
  logged — never allowed to 400 the batch.
- **A turn that seems to never answer:** run the app with `HOOK_DEBUG_TURN=1`
  and watch stderr — every step (placeholder saved, calling the model, model
  returned) is logged. `%APPDATA%pp.hook.chat\panic.log` catches panics.
  `finish()` converts any message still marked `streaming` into an error, so a
  dead turn can no longer leave the window spinning.
- **Git/sync behavior:** `server/sync.mjs` + `server/git.mjs` (limits, merge
  rules, endpoints) → `crates/hook-core/src/{sync,git}.rs` → `agent.rs` (env,
  managed config) → `hook-guard.mjs` (`sync_pull`/`sync_push`) → `turn.rs`
  (what the chat agent tells the coding agent) → Settings status → README
  **Sync between computers** and `infra/README.md`. Add to `server/sync.test.mjs`
  / `server/git.test.mjs` and the sync unit tests in `sync.rs`.
- **Phone product change:** `apps/mobile/src` (the phone's chrome and
  `mobile.css`) → `packages/chat` if the shared surface needs a prop → the
  Capabilities it passes in `apps/mobile/src-tauri/src/lib.rs`. A phone has no
  project folder, so `projects`, `coding_agents` and `preview_pages` stay off
  and the prompt sections that describe them are trimmed — do not add a phone
  branch to a component that already lives in `packages/chat`. Store builds
  come from Xcode and Gradle, never from `pnpm release`; `scripts/products.mjs`
  marks the product `kind: "mobile"` for that reason.
- **The Android project is generated, and two of its defaults are wrong.**
  `src-tauri/gen/android` is disposable: run `tauri android init`, then
  `pnpm tauri icon src-tauri/icons/source.png`, then build. Init copies the
  *template's* launcher icon, so skipping the icon step ships Tauri's mark under
  a Hook name. And init must be invoked through `npx` (or `pnpm tauri`), never
  `node scripts/tauri.mjs`: the CLI writes `BuildTask.kt` from how it was
  launched, and through the wrapper it writes `node tauri`, which cannot resolve
  and fails every Gradle build ([tauri#9536](https://github.com/tauri-apps/tauri/issues/9536)).
  `apps/mobile/package.json` carries the `tauri` script that the `npx` form
  needs. 16 KB page alignment (Android 15 refuses 4 KB libraries) is requested
  in `src-tauri/build.rs`, not in a cargo config file — `cargo-ndk` sets
  `CARGO_TARGET_*_RUSTFLAGS`, and an environment value beats the config.
- **Workspace entity or permission change:** `server/workspace.mjs` +
  `server/workspace.test.mjs` → the shared client and tool family in
  `crates/hook-core/src/workspace.rs` → the `ws_request` command →
  `apps/workspace/src/lib/bridge.ts` → store/components → README
  **Hook Workspace**. A new entity needs its own row in the changes feed, or a
  device will never learn about it. A task's `assignees` list holds each
  member's subject, or the address of someone invited who has not accepted —
  accepting the invitation rewrites every matching entry — and the legacy
  `assignee` column mirrors the first person for older readers. Anything that
  writes assignees must go through `assigneesFrom` / `resolveAssignees`, and
  anything that lists people needs the `pending` half.
- **New landing-page route or field:** `server/*.mjs` router → `waitlist/` UI →
  `server/*.test.mjs`. Keep old rows readable — tests deliberately seed an
  older schema.
- **New visual token or primitive:** `packages/ui/src/tokens.css`. The window is
  frameless and the glass is pure CSS, not an OS backdrop material. Plain CSS,
  no Tailwind utilities: the products keep hand-authored class names. A token
  declared **only** in `@theme` does not exist for a product that does not run
  the Tailwind plugin — the phone does not, so `--font-sans` was undefined there
  and every message rendered in Times. Declare it in `:root` and repeat it in
  `@theme` for the utility build.
- **AI reporting / Store policy 11.16, and reporting people:** `ReportDialog.tsx`
  + `MessageItem.tsx` → `bridge.ts`/`types.ts` → `commands::report_message` →
  `reports.rs` → `server/reports.mjs` → the `ai_reports` table →
  `scripts/ai-reports.sh`. Keep the "include the whole conversation" toggle
  opt-in. A *content* report (a task comment or a document someone else wrote,
  seen in the preview) is the same queue with `subject_kind = 'content'` and a
  `target` JSON column: `ReportContentDialog.tsx` → `commands::report_content`
  → the same row. Both stores require the second kind, not just the first.
- **New release/update behavior:** `scripts/products.mjs` →
  `server/releases.mjs` → `server/download.mjs` → `update.rs` →
  `src/lib/types.ts` → `bridge.ts` → the update store/component →
  `server/releases.test.mjs` and the `update.rs` tests. The release path is
  `scripts/release.sh` plus `scripts/release-gate.mjs` and
  `scripts/merge-release-index.mjs`; the checks that run on every push live in
  `.github/workflows/checks.yml`. One index per product:
  `/api/releases` (chat, historical) and `/api/releases/<product>`.
- **Store/update channel changes:** `msix/<product>/AppxManifest.xml` +
  `msix/<product>/identity.json` + the AppList icon set
  (`apps/<product>/src-tauri/icons/Square44x44Logo.targetsize-*`, regenerated by
  `pnpm msix:icons`; keep the `_altform-unplated` variants and a real
  `BackgroundColor`, or Windows plates the taskbar icon in the accent colour)
  → `scripts/build-msix.mjs` → `scripts/msix.test.mjs` → `update.rs` channel
  detection, `open_store_for_update` → the Store branches in `UpdatePrompt`,
  the update store and `SettingsSheet` → `release.config.json` `store` fields →
  README **Updating a Store install** and **The taskbar icon**.

## Hard constraints

- `harness.config.toml` is gitignored and `include_str!`d into `hook-core` — a
  missing file is a compile error. Never commit it or a real provider key. The
  key lives server-side; the renderer must never see a secret.
- **Git credentials are scoped.** The desktop mints `scope='git'` tokens; the app
  token (`scope='app'`) is what reads chats and spends model credits. Never put
  the app token in a project, URL or agent environment. The git token lives in
  `agent-home/gitconfig` and is rotated per device.
- **The account file is shared.** `%APPDATA%\app.hook\account.json` is read by
  every product; writes go through `auth.rs` (atomic, unique temp name) and a
  sign-out must clear the session for all of them. Never write a product-specific
  token there. `%APPDATA%\app.hook\memory\` is the same kind of shared,
  account-scoped data: one file per account, atomic writes with a unique temp
  name, and never uploaded to a different account (the file name is a hash of
  the account).
- **Never rewrite the request prefix.** Providers cache a request by its longest
  common prefix with an earlier one, so anything that changes the *start* of a
  turn's message list throws away the whole cached conversation. The leading
  system message is the instructions only; coding-agent notes and memory frames
  are hidden `system` messages appended when they happen and replayed in place by
  `build_history`; the live hint and window context are one trailing frame
  rebuilt per request. Memory is never re-retrieved per turn for the same reason.
  `cache_hit_tokens` in `usage_events` (written by `server/deepseek.mjs`) is how
  to check that a change did not break this.
- **Sync is account-scoped and automatic.** Chats/pictures/projects push and pull
  in the background while signed in; the server merges, never the client. A chat
  that is streaming is never uploaded or overwritten. A different account on the
  same machine quarantines the previous chats under `accounts/<id>/`; never
  upload one account's history to another. A `coding` chat is local-only on
  purpose: its folder, its engine process and its session file live on one
  computer, so `push_chats` skips it (and clears it from the queue). Never
  "fix" that by uploading one half.
- **A direct coding agent is the signed-in user.** It gets the chat agent's own
  tools through `bridge.rs`, whose token is minted per chat and only grants the
  names in that agent's `tools.json`; the endpoint is loopback-only. Creating
  one needs advanced mode, refuses without it in the backend (not just the UI),
  and no direct agent may start or steer another one.
- **Workspace permissions are server-side.** Viewer/editor/manager/owner is
  checked on every request; the UI's gating is cosmetic. The chat agent acts as
  the signed-in user and gets the same checks.
- **Git quotas are server-side.** 200 MB per project, 1 GB per account, 100 MB
  per push (`server/git.mjs` + `server/git-policy.mjs`). Do not remove the
  pre-receive hook; a push must be rejected before anything is written.
- Never edit generated or bundled trees: `target/`, `apps/*/src-tauri/gen/`,
  `apps/*/src-tauri/resources/pi-runtime/` (restored by `pnpm engine`),
  `apps/*/src-tauri/resources/git/` (restored by `pnpm git`), `dist/`,
  `dist-waitlist/`, `release/`.
- **A push to `main` deploys production.** `deploy-waitlist.yml` ships
  hookcode.io when the site or the server changed; an installer is published by
  `pnpm release`, which uploads the versioned file and swaps the index last. Do
  not push unless the user asked, and never run `pnpm release` without being
  asked for that release.
- **Never edit a version by hand.** Run `pnpm version:bump patch|minor|major`
  (add `--product workspace` for the second product); it updates that product's
  `package.json`, `Cargo.toml`, `Cargo.lock` and `tauri.conf.json` together. The
  release gate fails if they disagree, and refuses to republish an existing
  version with different source. `crates/hook-core/Cargo.toml` is not one of
  those files: its version is not a release number and is never bumped. A build
  reports whatever its product passes to `hook_core::builder`, so never read the
  version from `env!("CARGO_PKG_VERSION")` inside that crate — that is 0.2.1 in
  every release, which made Store builds show the wrong version and offer an
  update the Store had already installed.
- **Publishing must stay non-breaking.** Installers are immutable and versioned;
  a product's index is swapped last. Never delete or overwrite the installer the
  current index points at. The chat app's index keeps its historical URL.
- **The Store channel is separate.** A packaged (MSIX) build must never run the
  direct installer: it updates through the Store. `store.latest` is set only
  after Microsoft certifies that version. Store submissions are uploaded
  unsigned (`makeappx` without a cert), and the package is built locally
  (`pnpm app:msix`, or `pnpm release -- --store`) from the commit that was
  published — CI does not package it. The MSIX manifest opts out of AppData
  virtualization for its own `%APPDATA%\app.hook.<product>`; keep that so the two
  channels share data instead of forking it. MSIX also refuses to service a
  package in use (`ERROR_PACKAGES_IN_USE`, `0x80073D02`, which the Store reports
  as a bare "try again"), so the manifest sets
  `uap17:UpdateWhileInUse=defer` (Windows 11 24H2+, ignorable before it) and
  `open_store_update` closes Hook before opening the Store page. Keep both, the
  namespace in `IgnorableNamespaces`, and `scripts/msix.test.mjs` green. The
  Store product name for the chat app is **HookCode** (the manifest display
  name); the app UI stays Hook.
- **Store policy 11.16 is mandatory.** Live generative AI needs: the Report
  action on assistant replies, the AI disclosure in the listing, the Partner
  Center declaration, and a way to review reports (`scripts/ai-reports.sh`).
- **Never add a signing certificate or secret to the repo.** MSIX packages are
  re-signed by Microsoft; direct Windows signing, when added, belongs in CI
  secrets.
- Persistence is atomic on purpose (temp file + rename). Go through `store.rs`.
- Preview serving is loopback-only and path-contained (`preview.rs`); keep that
  when adding routes or file kinds.
- Two traps only appear in packaged builds (`strip_verbatim`, resource directory
  mapping). Both are documented and tested — keep the tests.

## Docs

`README.md` is the deep reference. Read the section instead of guessing:

- Invariants and architecture → **How it is put together**
- One account and several products → **One account, several products**
- Coding-agent runtime, RPC args, guard policy, preview → **Coding agents**
- Config keys and what is compiled in → **Configure**
- Version bumping, releasing an installer, updates → **Updates** and
  **Releasing**
- AI reporting for users and reviewers → **Reporting AI output**
- Microsoft Store setup/submission, MSIX, Store update cadence →
  **Microsoft Store (MSIX)**
- Local data layout (`%APPDATA%\app.hook*`) → **Where the data lives**
- Landing page, OAuth, model proxy → **Web waitlist** + `infra/README.md`
- Coverage → **Tests**
- Hook Browser (designed, not built) → `docs/browser-architecture.md`,
  `docs/browser-poc-plan.md`

**Keep docs in sync.** When a change alters commands, config keys, file layout,
data paths, runtime behavior or a user-visible flow, update this file and the
matching README section (and `infra/README.md` for server config) in the same
commit. Prefer a pointer to the code over a copy that will drift.
