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
packages/markdown/  the document dialect: one registry of rules, the parser the
                     live editor and the preview share, the read-only renderer,
                     and the deletion repair.
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

# The document dialect: the parser, the live editor's deletion repair and the
# read-only renderer (pure functions over Markdown, no window needed)
pnpm test:markdown

# Dependency licenses (also runs in CI, after `pnpm install`)
pnpm test:licenses

# The CLA gate's parsing rules (`.github/workflows/cla.yml`)
pnpm test:cla

# Bundled git and coding engine (pinned; ~93 MB and ~104 MB per app)
pnpm git
pnpm engine

# Hook Browser: the Chromium checkout lives outside the repo, see browser/README.md
pnpm browser:sync               # fetch/refresh the tree at browser/VERSION
pnpm browser:build              # gn gen + autoninja -C out/Dev chrome
pnpm browser:verify             # tag, overlay rule, patch stack, junction
pnpm browser:test

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
  spawn, states, plans, progress batching, wakes, stop. It points agents at the
  bundled git and the managed `agent-home/gitconfig` only when the account may
  sync; otherwise `HOOK_SYNC=0` and the guard leaves the git tools out. `transcript()` reads a
  run's pi session file (plus an in-memory tail from `message_update`) for the
  advanced inspector; it is read-only.
- `crates/hook-core/src/{relay,remote,devices}.rs` — the account relay client
  (presence, RPC, subscriptions, reconnect), the commands a controller sends to
  a host (`agent.start/steer/stop`, `projects.list`, `sessions.list`) and the
  description this machine registers. `docs/relay-protocol.md` is the contract;
  `docs/remote-control-status.md` is the handoff (what exists, what is left).
- `crates/hook-core/src/lib.rs` — `Product`, `Capabilities`, and the Tauri
  builder every product calls. A capability trims the prompt and the toolset; it
  must never change the data model. The six fields are places an answer can
  appear or things a device can reach: `preview_pages` (an HTML file served from
  a project), `preview_workspace` (a board, task or document — just account
  data), `coding_agents` (this process can run `pi`), `remote_agents` (it can
  drive a Hook host on another machine), `workspace_tools`, `projects` (a folder
  on this machine). `Capabilities::mobile()` is the phone: Workspace and the
  other machines, no local folder and no local engine. `Capabilities::workspace()`
  is a controller too: Hook on the same computer hosts the agent.
- `crates/hook-core/src/auth.rs` — device flow, the shared
  `%APPDATA%\app.hook\account.json`, per-product mirrors, git-token rotation,
  and the account side of entitlements: the plan, the account-wide cloud-sync
  switch, the shared advanced-mode preference and the free message window
  (`/api/auth/me`, `/api/auth/preferences`).
- `crates/hook-core/src/settings.rs` — this *product's* `settings.json`: the
  projects folder, the memory switch, this device's answer for advanced mode (a
  fallback when the account has none), and the personal model endpoint with the
  stamp of when it was last set or cleared. The key is never in the account
  file; it reaches the other products only through `server/provider.mjs`, which
  keeps it encrypted for a paid account whose sync switch is on.
- `server/plans.mjs` — the entitlement in one place: what `free` limits, the
  rolling 24-hour message window, and the sync refusal used by the proxy, the
  sync router, the git router, the provider router and the admin script. A
  waitlisted row has a null `plan`; `--approve` assigns `free` unless `--plan`
  says otherwise. `server/events.mjs` accepts the client-side
  analytics kinds the proxy cannot see (personal endpoint, quota refusal, sync
  switch).
- `crates/hook-core/src/{store,sync}.rs` — chats on disk and the background
  sync engine (cursor, pending queue, account quarantine, media, memory, the
  personal endpoint). `sync.rs` also owns the policy: a free account and an
  account whose switch is off never reach the network, and the loop re-checks
  `/api/auth/me` so a change made in another product arrives without a restart
  (plan, sync switch and advanced mode alike).
  `ChatMeta.kind = "coding"` marks a chat the user has with a coding agent
  directly: it carries `projectPath` and `sessionId`, and its content is never
  uploaded. Its **stub** (id, title, owning device, state, count) travels via
  `push_remote_stubs`/the `remoteChat` change; a viewer's cached copy is marked
  `remote` and is local-only too.
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
- `crates/hook-core/src/{provider,import,update,reports}.rs` — SSE client
  (`ProviderTarget` resolves each turn to Hook's proxy or the user's own
  endpoint), the ChatGPT/Claude export readers, the release index and update
  policy, AI reports.
- `crates/hook-core/src/commands.rs` — the whole IPC surface.
- `packages/chat/src/{Thread,MessageItem,TurnActivity,Composer}.tsx` — the
  conversation and the input, prop-driven and store-free. `TurnActivity` is the
  line that says what a running turn is doing ("Thinking…", "Searching the web
  for …"); the store hands it the labels and it owns the pacing. In advanced
  mode `Thread` keeps a turn in reading order (`turns.ts`): each message the
  model wrote, with one fold of thinking and tool calls between the messages,
  drawn by `WorkSteps.tsx`, so the conversation and the coding-agent inspector
  share one renderer. With advanced off the turn draws only its last message;
  the prompt always says that the final message is the complete answer, so the
  same reply works in both views. A direct coding chat opts out (`finalOnly`)
  because its engine is not given that rule.
  `apps/chat/src/components/{Thread,Composer}.tsx` are the thin store adapters;
  a product supplies the pictures (`renderExtras`) and what Report means
  (`onReport`).
  `apps/chat/src/components/{AgentTree,AgentInspector}.tsx` are the sidebar tree
  and the read-only transcript drawer. `chat.css` holds their styles and
  `dock.css` the 380px overrides, so both apps look the same.
- `packages/chat/src/ChatDock.tsx` — the collapsible chat panel every product
  embeds, built from those same pieces. It takes a `ChatTransport`, so it knows
  nothing about which app it is running in; a `DockChat.unsynced` flag draws the
  "not in the cloud" mark in its history, and the product supplies it;
  `apps/workspace/src/lib/chatTransport.ts` is that adapter.
- `packages/chat/src/RemoteChatDialog.tsx` — the host/project picker for a direct
  coding chat. It asks the chosen host for its projects (`remote_projects`), so
  it never types a path; the desktop's New chat menu and the phone's home screen
  open the same dialog. The chat itself stays on the host; `ChatMeta.remote`
  marks the local cache.
- `packages/markdown/` — the document dialect every Workspace surface draws.
  `rules.ts` is the registry (a word, an element, a class, a scope); `parse.ts`
  turns one inline block into constructs through micromark's directive grammar;
  `remark.ts` is the same grammar for `react-markdown`; `DocumentMarkdown.tsx`
  is the renderer `QuickPreview`, `WorkspacePreview` and the phone all use;
  `live.ts` is the CodeMirror half — decorations, the deletion repair, the
  toolbar's `applyRule`, and the callout scan. `rules.ts`,
  `packages/ui/src/tokens.css` and `docs/document-markdown.md` are the only
  three files a new rule touches: the last is the syntax a model reads through
  the `document_markdown` tool, embedded into `hook-core` by `include_str!`, and
  `reference.test.ts` fails when a registered rule is missing from it.
- `packages/chat/src/preview/` — `WorkspacePreview` and its three renderers,
  `reportableFrom` and `ReportContentDialog`. A document is drawn as a page:
  `.hook-doc` (`packages/ui/src/tokens.css`) is the read view's typography, and
  its numbers are the formatted editor's, so the panel and the phone sheet match
  the Workspace window instead of approximating it. A document's `direction`
  reaches this component from `workspace_preview` and flips it through `dir`;
  keep new rules logical (`padding-inline-start`, `text-align: start`) or RTL
  silently breaks. The JSON is what
  `workspace_preview` returned; the components own no frame, so `PreviewPanel`
  (desktop, side panel) and `apps/mobile/src/components/PreviewSheet.tsx`
  (phone, bottom sheet) draw the same thing. A task's comments are other
  people's words: that is what `ReportContentDialog` is for, not the AI report.
- `packages/chat/src/images/` — the picture strip and its lightbox. A product
  supplies `load`, the only part that knows where the bytes are; `onOpen` and
  `onSaveAs` are optional, so a phone draws neither button. The chat window
  reads from the chat's image folder, the phone from the same folder inside its
  own container.
- `apps/mobile/` — HookCode on a phone. Three screens (a new chat, the chat
  list, a thread), two sheets (preview, settings) and `mobile.css`, which is
  the phone's re-skin of the shared surface the way `dock.css` is the 380px one.
  The home screen is a new conversation, like the desktop's; the archive opens
  behind the history button on the home screen and in the conversation header.
  `src/lib/back.ts` routes the Android back gesture
  to that navigation and closes a sheet or dialog before leaving a screen.
  `src-tauri` passes `Product::Mobile` + `Capabilities::mobile()`; it can drive
  agents on the account's computers (`remote_agents`) but has no local engine
  and no folder picker. It ships through the stores, and `scripts/release.sh`
  does not build it.
- `browser/` — Hook Browser's build environment, and the only part of the browser
  that is in this repository. `VERSION` is the one pinned Chromium tag,
  `args.gn` the dev GN args, `overlay/src/hook/` the new paths that are
  junctioned into the checkout as `src/hook`, `patches/series` the small edits to
  upstream files that survive a rebase, and `tools/{sync,build,verify,patch}.mjs`
  the whole interface. The ~100 GB checkout itself never enters the repo and
  `browser/README.md` carries the dev loop, the toolchain prerequisites and the
  traps. `args.gn` pins `use_siso = false`: siso cannot read the overlay
  junction, so the tree builds with ninja (`browser/README.md`, "Traps").
  Nothing in `scripts/products.mjs` or `pnpm release` knows about it: no
  Chromium build ever runs on a push.
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
- `server/platform.mjs` — mounts waitlist, device login, download, sync, git,
  events, devices, the preview ticket route and the model proxy under `/api`.
- `server/devices.mjs` — the account's machine registry (`GET/PATCH/DELETE
  /api/devices`) and the in-memory presence map.
- `server/relay.mjs` — the WebSocket hub at `/api/relay`: host/controller
  connections, presence, RPC routing, per-chat fan-out, preview frames.
- `server/preview-tunnel.mjs` — `*.preview.hookcode.io`: mints a ticket and
  tunnels each HTTP request over the machine's outbound socket.
- `server/workspace.mjs` — Workspace projects/boards/tasks/documents/members.
- `infra/` — reference server config, uploaded by `scripts/deploy-waitlist.sh`.
  `preview.caddy` is the per-preview site block; `hook-preview-cert.cron` renews
  its wildcard certificate. The Cloudflare API token lives only on the VPS.
- `release.config.json` — per-product minimum versions and the Store channel:
  the listing id (`store.productId`), the certified Store version and its floor.
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
- **New document directive (a new parser for Workspace Markdown):**
  `packages/markdown/src/rules.ts` (one entry: `names`, `scope`, `element`,
  `className`, `family`) → its class in `packages/ui/src/tokens.css` → a line in
  `docs/document-markdown.md` (the reference `document_markdown` hands the model)
  → nothing else. The live editor's decorations, the deletion repair, the
  toolbar, `remark.ts` and every preview read the registry, so they cannot
  drift; add a case to `parse.test.ts` and `remark.test.ts`, and a toolbar button
  in `apps/workspace/src/components/DocumentEditor.tsx` only if a person needs to
  reach it. The reference is part of the job: an undocumented rule is one no
  agent will ever use. A rule must never map to `style`, to a handler or to raw HTML: raw
  HTML is not parsed at all, which is what lets documents be shared without a
  sanitizer. Never let the editor and the preview parse separately — both go
  through `micromark`'s directive grammar, and a hand-rolled matcher for one
  side is how a formatted run ends up looking different from the page.
- **Formatted-editor editing rule (deletion, the caret):** inline markup is
  invisible, so an edit must never change it — `repairTransaction` in
  `packages/markdown/src/live.ts` puts the markers back around whatever survived
  and removes a construct only when its content is gone. A Backspace that lands
  on an invisible marker therefore deletes the neighbouring *character*. A marker
  also draws at the same place as the content edge beside it, so the caret stops
  only on the content edge (`settle` / `settleSelection`): one arrow press always
  crosses a visible character, typing at the end of a run stays in the run, and
  the ghost position beside the marker is never a stop. Blocks and pictures are
  units: a delete at their edge removes them. Do not "fix" this by revealing
  markers when the caret arrives — the point is that a reader never sees them.
- **Chat surface change:** `packages/chat/src` (component + `chat.css`) → check
  it at both sizes (the chat window and the 380px dock) → the adapters in
  `apps/chat/src/components` if the store gains a prop. Never fork a component
  into one app: the dock and the window are meant to be the same thing. The
  activity line (`TurnActivity.tsx`, drawn by `Thread.tsx`) is the *empty*
  reply's place: a message that is merely streaming must not hide it, or a
  thinking model leaves a blank window for half a minute. Only text that is on
  screen counts as "arriving". With Advanced off the thread draws only the
  turn's last message (`turns.ts`; a direct coding chat opts out with
  `finalOnly`). The prompt's **Style** section always says the final message is
  the complete answer, independent of the mode, so the same reply works in both
  views.
- **Advanced-mode change (thinking, tool calls, coding-agent inspector):**
  `server/auth.mjs` (`advanced_mode` column, `advancedMode` on `publicUser` and
  `/api/auth/preferences`) → `auth.rs` (`advanced_mode` on the session,
  `set_advanced_mode`; `sync.rs::refresh_account` seeds a window that already had
  it on) → `settings.rs` (`advanced_mode`, the signed-out fallback) →
  `commands.rs` (`set_advanced_mode`, `settings_view`) →
  `bridge.ts` / `types.ts` / `mock.ts` → the settings in the store →
  `Thread showDetails` → `packages/chat/src/turns.ts` and `WorkSteps.tsx`.
  It is account state, not product state: the phone follows the computer, a free
  account may set it (it is a boolean, not content), and `settings.json` only
  answers when the account has no value.
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
  `PaneHead`, `AgentBoard`, `Composer` (`steer`). Four filters matter: the
  sidebar hides these chats while Advanced is off, the phone's archive does the
  same (`ChatList`), `setAdvancedMode` closes one that is already open (the
  simple view cannot fold its per-tool turns), and `AgentTree` skips `direct`
  runs; `apps/workspace`'s chat transport always filters them out. The phone's
  **Code on <machine>** chip is an Advanced action for the same reason: with it
  off the chat agent starts the run, not a button.
  One trap: a direct run starts from `send_message`. It is now async so the
  remote path can wait for an RPC, but the agent driver and the turn still use
  `tauri::async_runtime` (the driver spawn in `agent.rs` included). A
  `tokio::spawn` from a context with no reactor panics with "there is no reactor
  running" and aborts the window, because a panic in a command thread cannot
  unwind.
- **Free-plan / entitlement change:** `server/plans.mjs` (the rule and the 24-hour
  window) → `server/deepseek.mjs` (refusals, `plan`/`message_id` on
  `usage_events`) → `server/sync.mjs` and `server/provider.mjs` (the gates) →
  `auth.rs` (`plan`, `cloud_sync`, `quota` on the session and `AuthView`) →
  `sync.rs` (`policy_for`, the minute `/me` poll, `SyncView.available`/`reason`) →
  `provider.rs` (`ProviderTarget`) → `settings.rs` (the personal provider) →
  `commands.rs` + `generate_handler!` → `bridge.ts` / `types.ts` / `mock.ts` →
  `SettingsSheet` (all three products) and `ChatRow`'s cloud mark. The server
  enforces; the window only explains, and a local check must never be looser
  than the server's. `syncRefusal()` and `policy_for()` are the two halves of
  one rule and must be changed together.
- **New analytics event:** a kind in `KINDS` (`crates/hook-core/src/analytics.rs`)
  *and* in `server/events.mjs` (the server rejects anything else), then
  `analytics::track(state, kind)` at the call site. Only the kind, plan, product
  and app version travel: no message, path, endpoint or key. `--events` in
  `scripts/waitlist-admin.sh` reads them.
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
- **Personal model endpoint sync (the account copy of a BYOK key):**
  `settings.rs` (`custom_provider_changed_at`, `adopt_provider`) →
  `sync.rs` (`sync_provider` / `push_provider` / `pull_provider`, which run inside
  the ordinary cycle and are gated by the same policy) → `server/provider.mjs`
  (AES-256-GCM with `HOOK_PROVIDER_SECRET`, metadata and secret on separate
  routes, `syncRefusal` on every one) → `server/api.mjs` (`account_provider`) →
  `server/provider.test.mjs`. The key is a credential: never log it, never put it
  in a `/changes` payload or an analytics event, never return it from the
  metadata route, and keep a clear a tombstone with the fields emptied. The
  client sends the stamp the user's action recorded; an older stamp never wins.
  A key belongs to the account that typed it (`custom_provider_account`): when a
  different account signs in on the same machine the endpoint is neither pushed
  nor pulled, so one person's key cannot cross into another's cloud account.
  A server without the secret stores nothing — do not add a plaintext fallback.
- **Remote control / a new machine operation:** `docs/relay-protocol.md` →
  `server/{devices,relay}.mjs` (+ `server/api.mjs` migrations) →
  `crates/hook-core/src/{devices,relay,remote}.rs` → `tools.rs` (a required
  `machine` argument) and the prompt's **Coding agents** section → `commands.rs`
  + `generate_handler!` → `bridge.ts` / `types.ts` / `mock.ts` →
  `MachinesSection` and the agent board. A controller sends an RPC; the host
  executes it. Never let a controller run a local `AgentManager`. Project
  creation is a host RPC too (`projects.create`); the caller supplies a name,
  never a path.
- **Remote direct coding chat:** the host keeps the folder, engine and session;
  only a stub travels. `store.rs` (`deviceId`, `deviceName`, `remote`,
  `stubState`, `is_owned_coding`, `apply_stub`) → `sync.rs`
  (`push_remote_stubs`, `pending_stub_deletes`, the `remoteChat` pull arm) →
  `server/api.mjs` (`sync_remote_chats`) and `server/sync.mjs`
  (`/remote-chats`, the `/changes` union; a full `kind: "coding"` chat is
  refused) → `remote.rs` (`coding.create/fetch/send/stop/answer/rename`,
  `projects.create`) →
  `commands.rs` (`create_remote_coding_chat`, `fetch_remote_chat`,
  `remote_projects`, remote branches in `send_message`/`stop_stream`/
  `rename_chat`/`answer_coding_agent`) → `bridge.ts` / `types.ts` / `mock.ts` →
  `RemoteChatDialog` (`packages/chat`) → the Sidebar's New chat menu and the
  phone's Home. The viewer's cache is `remote: true` and `is_local_only`, so
  `push_chats` never uploads it; the owner's delete queues a tombstone. Do not
  let a viewer delete or change the folder: those belong to the host.
- **Remote preview:** the host publishes a `preview` event (the same
  `PreviewView`); `relay.rs` mints a ticket through `POST
  /api/remote/preview/ticket`, `server/preview-tunnel.mjs` serves the subdomain,
  and `preview.rs::fetch` answers the tunneled request from the active preview's
  folder. The page's own folder is the root; keep `fetch` path-contained.
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
  / `server/git.test.mjs` and the sync unit tests in `sync.rs`. Message order is
  transcript order, never `createdAt` order: a tool result has to sit directly
  after the assistant message that called it, while the memory frame is written
  at the top of a chat although it is created later. Sorting by time once put
  the frame between a call and its result, and the endpoint then refused every
  later message in that conversation with "an assistant message with
  'tool_calls' must be followed by tool messages". `turn.rs::build_history`
  replays each call together with its results and drops a call whose result is
  missing, so one bad row cannot poison a conversation.
- **Phone product change:** `apps/mobile/src` (the phone's chrome and
  `mobile.css`) → `packages/chat` if the shared surface needs a prop → the
  Capabilities it passes in `apps/mobile/src-tauri/src/lib.rs`. A phone has no
  project folder, so `projects`, `coding_agents` and `preview_pages` stay off
  and the prompt sections that describe them are trimmed — do not add a phone
  branch to a component that already lives in `packages/chat`. Store builds
  come from Xcode and Gradle, never from `pnpm release`; `scripts/products.mjs`
  marks the product `kind: "mobile"` for that reason.
  The Android window has one native fix of its own: `plugins/mobile-shell`
  pads the shell by the IME inset (targetSdk 35+ no longer resizes an
  edge-to-edge app for the keyboard, and the system pans the whole screen
  otherwise). The back gesture is `src/lib/back.ts` plus
  `core:app:allow-exit`; registering a `back-button` listener turns off the
  app plugin's own close, so every press must be answered.
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
- **Board templates and property types:** a template is configuration in
  `apps/workspace/src/lib/boardTemplates.ts`; it may only suggest a name, a set
  of board columns (properties), a default view and example rows, and it creates
  an ordinary board. Never add a template-specific entity, endpoint or table.
  A new property type goes through `ColumnType` in `types.ts`, `parseColumns` +
  `validateFields` in `server/workspace.mjs`, the cell editor in `BoardTable.tsx`
  (and the type menu in `BoardPropertiesDialog.tsx`), then can be used by any
  template. Task values stay in `fields`; status and assignees remain the two
  first-class task columns.
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
  the update store and `SettingsSheet` → `release.config.json` `store` fields
  (`productId` → `server/releases.mjs` `storeListing` → `/api/waitlist/status`
  → the approved screen in `waitlist/OnboardingPanels.tsx`, which links the
  Store and never an installer) → README **Updating a Store install**, **The
  taskbar icon** and **Microsoft Store (MSIX)**.
- **New dependency (npm or crate):** run `pnpm test:licenses` before you commit.
  It fails on strong copyleft, source-available licenses and anything
  unrecognised, because Hook is `AGPL-3.0-only` and dual-licensed — a dependency
  it cannot ship would decide Hook's license for it. Add an entry to
  `THIRD_PARTY_NOTICES.md` when the license is anything other than plain
  MIT/Apache/BSD. An exception lives in `EXCEPTIONS` in
  `scripts/check-licenses.mjs` *and* in the notices file, with a reason. The
  About panel (`apps/chat/src/components/AboutSection.tsx`) is where a user
  reads the result, so a component that is actually redistributed as a binary
  belongs in its `BUNDLED` list too.

## Hard constraints

- **The license is `AGPL-3.0-only`, and it is load-bearing.** Hook is dual-licensed
  (AGPL + commercial), which is why every non-trivial contribution needs a CLA.
  Never change the license, never drop a copyright or license notice, and never
  remove the attribution of a bundled component. A new dependency must be checked
  against `THIRD_PARTY_NOTICES.md` before it is merged — nothing copyleft, nothing
  unlicensed. The bundled MinGit is GPL-2.0-only and is safe **only** as a
  separate, unlinked executable: never link against it or copy its source into
  `hook-core`.
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
  token there. A personal model key is exactly that kind of thing: it lives in
  the product's `settings.json`, never in the account file, and it leaves this
  computer only for the endpoint it names — plus the encrypted account copy
  below. `%APPDATA%\app.hook\memory\` is the same kind of shared,
  account-scoped data: one file per account, atomic writes with a unique temp
  name, and never uploaded to a different account (the file name is a hash of
  the account).
- **A personal model key is a credential, and the account keeps only ciphertext.**
  It reaches another product only through `server/provider.mjs`: AES-256-GCM with
  the account subject as additional data, the key derived from
  `HOOK_PROVIDER_SECRET`, `no-store`, metadata and secret on separate routes, and
  a paid plan with cloud sync required. Never log it, never include it in
  `/api/sync/changes`, `/api/auth/me`, an analytics event, an error message or a
  support report, and never fall back to storing it in the clear when the
  deployment has no secret. A clear is a tombstone whose fields are emptied, so a
  stale push cannot resurrect a key the user removed.
- **Never rewrite the request prefix.** Providers cache a request by its longest
  common prefix with an earlier one, so anything that changes the *start* of a
  turn's message list throws away the whole cached conversation. The leading
  system message is the instructions only; coding-agent notes and memory frames
  are hidden `system` messages appended when they happen and replayed in place by
  `build_history`; the live hint and window context are one trailing frame
  rebuilt per request. Memory is never re-retrieved per turn for the same reason.
  `cache_hit_tokens` in `usage_events` (written by `server/deepseek.mjs`) is how
  to check that a change did not break this.
- **Sync is account-scoped, and off means off.** Chats/pictures/projects push
  and pull in the background while a paid account has the account-wide switch on;
  a free account never syncs, and the server refuses both cases
  (`sync_not_included` / `sync_disabled`) on the sync routes and on `/api/git`
  alike: a repository is account data too, so no plan means no remote, no git
  token and no `sync_pull`/`sync_push` in an agent. The switch is account state,
  not a product setting: do not move it into `settings.json`. The server merges,
  never the client. A chat that is streaming is never uploaded or overwritten,
  and a copy the account sends back is never applied when the file is newer than
  it (`sync.rs::local_wins`, both on the push response and on the pull): a push
  can stay in flight for seconds while a picture uploads, and the merge it
  returns predates the reply the turn wrote meanwhile. The chat stays dirty, so
  the next cycle merges both sides. A different account on the same machine
  quarantines the previous chats under `accounts/<id>/`; never upload one
  account's history to another. A `coding` chat's **content** is
  local-only on purpose: its folder, its engine process and its session file
  live on one computer, so `push_chats` skips it (and clears it from the queue).
  Its **stub** is the one exception: `push_remote_stubs` sends the id, title,
  owner, state and count, and never a message, path or session. A viewer's cache
  is local-only too. Never "fix" either half by uploading the transcript.
- **A direct coding agent is the signed-in user.** It gets the chat agent's own
  tools through `bridge.rs`, whose token is minted per chat and only grants the
  names in that agent's `tools.json`; the endpoint is loopback-only. Creating
  one needs advanced mode *and* either a paid plan or a personal model endpoint;
  the backend refuses without them (not just the UI), and no direct agent may
  start or steer another one. A free account's endpoint is what makes the
  exception real: it is also what keeps that agent off Hook's metered proxy.
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
  when adding routes or file kinds. The remote tunnel is the only other way in:
  it reads through `PreviewManager::fetch` under the same root, never a second
  file server.
- **The Chromium overlay is new paths only.** `browser/overlay/src/hook/` must not
  contain a copy of an upstream file — `pnpm browser:verify` fails if it does,
  because a copy silently recreates the merged fork one stale file at a time.
  Upstream edits go in `browser/patches/series`, one reviewable hunk at a time,
  and they are expected to fail loudly when the tag moves.
- Two traps only appear in packaged builds (`strip_verbatim`, resource directory
  mapping). Both are documented and tested — keep the tests.

## Docs

`README.md` is the deep reference. Read the section instead of guessing:

- Invariants and architecture → **How it is put together**
- One account and several products → **One account, several products**
- Coding-agent runtime, RPC args, guard policy, preview → **Coding agents**
- Plans, the free limits, the account sync switch and personal endpoints →
  **Plans, limits and your own model**
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
- License, what a fork may do, bundled third-party terms → **License** in
  `README.md`, plus `LICENSE`, `TRADEMARK.md`, `THIRD_PARTY_NOTICES.md`,
  `CONTRIBUTING.md` and `CLA.md`

**Keep docs in sync.** When a change alters commands, config keys, file layout,
data paths, runtime behavior or a user-visible flow, update this file and the
matching README section (and `infra/README.md` for server config) in the same
commit. Prefer a pointer to the code over a copy that will drift.
