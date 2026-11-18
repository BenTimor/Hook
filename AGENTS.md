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
| Landing page | `waitlist/` | `pnpm waitlist:dev` → :5173 | `pnpm waitlist:build` → `dist-waitlist/` | `.github/workflows/deploy-waitlist.yml` |
| Account service | `server/` | `pnpm waitlist:start` | Docker image | `scripts/deploy-waitlist.sh` |

Shared, and the reason the products look and behave alike:

```
crates/hook-core/    the backend every product links: account, chats + sync,
                     coding agents, preview, the assistant turn, the IPC surface
packages/ui/         tokens.css, window chrome, buttons/inputs, dialogs, the mark
packages/chat/       the chat surface: Markdown, CodeBlock, Thread, MessageItem,
                     Composer, and the ChatDock panel every product embeds
```

`server/` and `waitlist/` deliberately stay at the repo root: they are one deploy
unit (one container, one `/data` volume) that every product talks to, not an app
you build alongside the others.

## Commands

```bash
# Desktop apps
cp harness.config.ci.toml harness.config.toml  # required before any cargo build
pnpm dev                          # chat UI in a plain browser (mock backend)
pnpm app                          # chat product: real Tauri window, hot reload
pnpm workspace:dev                # Workspace UI in a plain browser
pnpm workspace:app                # Workspace: real Tauri window
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

## Where things live

- `crates/hook-core/src/turn.rs` — the assistant turn (model → tools → answer),
  the system prompt, streaming and cancellation. Largest, most delicate file.
- `crates/hook-core/src/tools.rs` — chat-agent tool schemas and implementations.
- `crates/hook-core/src/agent.rs` — supervisor for `pi` subprocesses over RPC:
  spawn, states, plans, progress batching, wakes, stop. It also points agents at
  the bundled git and the managed `agent-home/gitconfig`.
- `crates/hook-core/src/lib.rs` — `Product`, `Capabilities`, and the Tauri
  builder both apps call. A capability trims the prompt and the toolset; it must
  never change the data model.
- `crates/hook-core/src/auth.rs` — device flow, the shared
  `%APPDATA%\app.hook\account.json`, per-product mirrors, git-token rotation.
- `crates/hook-core/src/{store,sync}.rs` — chats on disk and the background
  sync engine (cursor, pending queue, account quarantine, media).
- `crates/hook-core/src/{git,projects}.rs` — bundled MinGit, scoped git config,
  project folders and their account ids. "Project" here means a **code project**,
  a folder on disk; Workspace projects are a different thing (`ws_` ids).
- `crates/hook-core/src/{preview,runtime,guard}.rs` — loopback preview server,
  engine lookup, and the guard extension (`resources/hook-guard.mjs`, embedded
  with `include_str!`; edit the `.mjs`).
- `crates/hook-core/src/{provider,import,update,reports}.rs` — SSE client, the
  ChatGPT/Claude export readers, the release index and update policy, AI reports.
- `crates/hook-core/src/commands.rs` — the whole IPC surface.
- `packages/chat/src/{Thread,MessageItem,TurnActivity,Composer}.tsx` — the
  conversation and the input, prop-driven and store-free. `TurnActivity` is the
  line that says what a running turn is doing ("Thinking…", "Searching the web
  for …"); the store hands it the labels and it owns the pacing. `apps/chat/src/
  components/{Thread,Composer}.tsx` are the thin store adapters; a product
  supplies the pictures (`renderExtras`) and what Report means (`onReport`).
  `chat.css` holds their styles and `dock.css` the 380px overrides, so both apps
  look the same.
- `packages/chat/src/ChatDock.tsx` — the collapsible chat panel every product
  embeds, built from those same pieces. It takes a `ChatTransport`, so it knows
  nothing about which app it is running in;
  `apps/workspace/src/lib/chatTransport.ts` is that adapter.
- `apps/chat/src/lib/bridge.ts` — typed `invoke` wrappers and app-wide events
  (`hook://chat`, `hook://agents`, `hook://preview`, `hook://auth`,
  `hook://sync`, `hook://import`, `hook://update`).
- `apps/chat/src/store/useChatStore.ts` — all chat state; coalesces stream deltas.
- `apps/workspace/src/components/WorkspaceHome.tsx` — invitations, projects and
  getting-started actions. `InvitationCard.tsx` shares response states with the
  Invites inbox; sender profiles are optional fields from `GET /api/ws/invites`.
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
- **Chat surface change:** `packages/chat/src` (component + `chat.css`) → check
  it at both sizes (the chat window and the 380px dock) → the adapters in
  `apps/chat/src/components` if the store gains a prop. Never fork a component
  into one app: the dock and the window are meant to be the same thing.
- **New chat-agent tool:** schema + impl in `tools.rs`, dispatch in `turn.rs`,
  and the prompt in `turn.rs` (`system_prompt`) if the agent must know about it.
  Give it a line in `activity_label` (`turn.rs`): that is what the chat says it
  is doing while the tool runs, and a test fails when an advertised tool has
  none. Gate it on `Capabilities` when only some products have it.
- **New product:** `apps/<id>/` (package.json, index.html, vite.config.ts,
  `src-tauri/` with its own identifier) → `Product` + `Capabilities` in
  `crates/hook-core/src/lib.rs`, plus its own version passed to
  `hook_core::builder(product, capabilities, env!("CARGO_PKG_VERSION"))` → an
  entry in `scripts/products.mjs` → root scripts → its own `msix/<id>/`. Every
  product is built and published by
  `pnpm release` (`scripts/release.sh`); add its `package.json` to the manifest
  copies in `Dockerfile` so a workspace install still resolves.
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
- **Workspace entity or permission change:** `server/workspace.mjs` +
  `server/workspace.test.mjs` → the shared client and tool family in
  `crates/hook-core/src/workspace.rs` → the `ws_request` command →
  `apps/workspace/src/lib/bridge.ts` → store/components → README
  **Hook Workspace**. A new entity needs its own row in the changes feed, or a
  device will never learn about it.
- **New landing-page route or field:** `server/*.mjs` router → `waitlist/` UI →
  `server/*.test.mjs`. Keep old rows readable — tests deliberately seed an
  older schema.
- **New visual token or primitive:** `packages/ui/src/tokens.css`. The window is
  frameless and the glass is pure CSS, not an OS backdrop material. Plain CSS,
  no Tailwind utilities: the products keep hand-authored class names.
- **AI reporting / Store policy 11.16:** `ReportDialog.tsx` + `MessageItem.tsx`
  → `bridge.ts`/`types.ts` → `commands::report_message` → `reports.rs` →
  `server/reports.mjs` → the `ai_reports` table → `scripts/ai-reports.sh`.
  Keep the "include the whole conversation" toggle opt-in.
- **New release/update behavior:** `scripts/products.mjs` →
  `server/releases.mjs` → `server/download.mjs` → `update.rs` →
  `src/lib/types.ts` → `bridge.ts` → the update store/component →
  `server/releases.test.mjs` and the `update.rs` tests. The release path is
  `scripts/release.sh` plus `scripts/release-gate.mjs` and
  `scripts/merge-release-index.mjs`; the checks that run on every push live in
  `.github/workflows/checks.yml`. One index per product:
  `/api/releases` (chat, historical) and `/api/releases/<product>`.
- **Store/update channel changes:** `msix/<product>/AppxManifest.xml` +
  `msix/<product>/identity.json` → `scripts/build-msix.mjs` → `update.rs`
  channel detection/`store_url` → the Store branches in `UpdatePrompt` and the
  update store → `release.config.json` `store` fields → README **Microsoft
  Store**.

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
  token there.
- **Sync is account-scoped and automatic.** Chats/pictures/projects push and pull
  in the background while signed in; the server merges, never the client. A chat
  that is streaming is never uploaded or overwritten. A different account on the
  same machine quarantines the previous chats under `accounts/<id>/`; never
  upload one account's history to another.
- **Workspace permissions are server-side.** Viewer/editor/manager/owner is
  checked on every request; the UI's gating is cosmetic. The chat agent acts as
  the signed-in user and gets the same checks.
- **Git quotas are server-side.** 200 MB per project, 1 GB per account, 50 MB per
  push (`server/git.mjs` + `server/git-policy.mjs`). Do not remove the pre-receive
  hook; a push must be rejected before anything is written.
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
  channels share data instead of forking it. The Store product name for the chat
  app is **HookCode** (the manifest display name); the app UI stays Hook.
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

**Keep docs in sync.** When a change alters commands, config keys, file layout,
data paths, runtime behavior or a user-visible flow, update this file and the
matching README section (and `infra/README.md` for server config) in the same
commit. Prefer a pointer to the code over a copy that will drift.
