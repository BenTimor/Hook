# AGENTS.md

Onboarding for coding agents working on Hook. If your change makes a line here
wrong, fix it in the same commit.

## What this is

A local AI chat desktop app — Tauri 2 (Rust) + React 19 + TypeScript — with
coding agents that run as bundled `pi` subprocesses. The repo holds **two
separate products** that only share tooling:

|                | Desktop app                      | Landing page                        |
| -------------- | -------------------------------- | ----------------------------------- |
| Code           | `src/` (React), `src-tauri/` (Rust) | `waitlist/` (React), `server/` (Express) |
| Dev            | `pnpm dev` or `pnpm app`         | `pnpm waitlist:dev` → :5173         |
| Build          | `pnpm app:build` / `pnpm app:portable` | `pnpm waitlist:build` → `dist-waitlist/` |
| Deploy         | `.github/workflows/release-app.yml` | `.github/workflows/deploy-waitlist.yml` |

The only real coupling: `waitlist/` imports `src/components/HookMark`. Otherwise
changes do not cross over.

## Commands

```bash
# Desktop app
cp harness.config.ci.toml harness.config.toml  # required before any cargo build
pnpm dev           # UI in a plain browser, in-memory mock backend — fastest UI loop
pnpm app           # real Tauri window with hot reload
pnpm typecheck     # tsc --noEmit across src/ + waitlist/ (the only static gate)
pnpm app:build     # NSIS installer (fetches the pi runtime and git first)
pnpm app:msix      # unsigned Microsoft Store MSIX (same exe, package identity)
pnpm version:bump patch   # patch|minor|major — never edit a version by hand
cd src-tauri && cargo test                       # no engine or network needed
cd src-tauri && cargo test --lib -- --ignored    # live tests; run `pnpm mock` first

# Landing page
pnpm waitlist:dev
pnpm waitlist:test  # API, device login, proxy, download, release index
pnpm waitlist:build

# Release pipeline (Node only, no install needed)
pnpm test:release   # the "needs a Windows build?" gate + index merge

# Bundled git for coding agents (pinned MinGit, ~93 MB extracted)
pnpm git

# Offline chat against a fake OpenAI-compatible endpoint on :8787
pnpm mock
```

No ESLint, Prettier or rustfmt config. Match the file you are editing.

## Where things live

- `src-tauri/src/turn.rs` — the assistant turn (model → tools → answer), the
  system prompt, streaming and cancellation. Largest, most delicate file.
- `src-tauri/src/tools.rs` — chat-agent tool schemas and implementations.
- `src-tauri/src/agent.rs` — supervisor for `pi` subprocesses over RPC: spawn,
  states, plans, progress batching, wakes, stop. It also points agents at the
  bundled git and the managed `agent-home/gitconfig`.
- `src-tauri/src/git.rs` — locate bundled MinGit, write the scoped git config,
  prepare a project repository/remote, take the first snapshot, push/pull.
- `src-tauri/src/sync.rs` — background conversation, picture and project-metadata
  sync: cursor, pending queue, account quarantine, `hook://sync` events.
- `server/git.mjs` — `/api/git/<project id>.git` smart HTTP via `git http-backend`;
  one bare repo per project under `/data/git`. `server/git-policy.mjs` is the
  pre-receive size hook installed into every repo.
- `server/sync.mjs` — `/api/sync/*`: monotonic cursor, server-side chat merge,
  project identity, content-addressed media, quotas and account deletion.
- `src-tauri/resources/hook-guard.mjs` — the guard extension injected into
  every coding agent (bash timeouts, `update_plan`, `show_preview`,
  `web_search`). `guard.rs` embeds it via `include_str!`; edit the `.mjs`.
- `src-tauri/src/update.rs` — public release index, the required/optional
  decision, checksum-checked download, NSIS hand-off.
- `src-tauri/src/reports.rs` — in-app reports of inappropriate AI output;
  `server/reports.mjs` stores them and `scripts/ai-reports.sh` reviews them.
- `src-tauri/src/{provider,store,config,runtime,preview,projects,settings,auth}.rs`
  — SSE client, atomic JSON persistence, compiled TOML, engine lookup, loopback
  preview server, projects store, projects-folder setting, device login.
- `src-tauri/src/commands.rs` — the whole IPC surface.
- `src/lib/bridge.ts` — typed `invoke` wrappers and app-wide events
  (`hook://chat`, `hook://agents`, `hook://preview`, `hook://auth`,
  `hook://update`).
- `src/lib/types.ts` — the types on both sides of that bridge.
- `src/store/useChatStore.ts` — all zustand state; coalesces stream deltas.
- `src/components/` — UI. `src/styles/index.css` — tokens, glass, prose.
- `waitlist/content.json` — all landing-page copy and interest definitions.
- `server/platform.mjs` — mounts waitlist, device login, download and model
  proxy under `/api`.
- `infra/` — reference server config, uploaded by `scripts/deploy-waitlist.sh`.
- `release.config.json` — the direct and Store floors, and the Store's latest.
- `msix/identity.json` — Partner Center identity + the MSIX manifest template.
- `scripts/build-msix.mjs` — packages Hook.exe + the engine as an unsigned MSIX.
- `scripts/fetch-git.mjs` — pinned MinGit into `src-tauri/resources/git/`.
- `scripts/app-source-hash.mjs` — what counts as a change to the desktop app.
- `scripts/release-gate.mjs` — decides whether a push needs a Windows build.
- `scripts/merge-release-index.mjs` — folds a build into `releases.json`.

## Touch every layer

Changing one side of a boundary is the most common way to break this repo.

- **New IPC command:** `commands.rs` → `generate_handler!` in `lib.rs` →
  `bridge.ts` wrapper → `types.ts` → the `mock.ts` fallback → store/component.
  Both `isTauri()` branches must work.
- **New chat-agent tool:** schema + impl in `tools.rs`, dispatch in `turn.rs`,
  and the prompt in `turn.rs` (`system_prompt`) if the agent must know about it.
- **New guard behavior:** `src-tauri/resources/hook-guard.mjs`, plus `tools.rs`
  if it calls back into Rust; then `src-tauri/tests/guard_policy.rs` +
  `tests/fixtures/guard-harness.mjs`. The guard may only import `node:*`
  built-ins — it is copied into the user's data folder where nothing resolves.
- **Git/sync behavior:** `server/sync.mjs` + `server/git.mjs` (limits, merge
  rules, endpoints) → `src-tauri/src/sync.rs` / `git.rs` → `agent.rs` (env,
  managed config) → `hook-guard.mjs` (`sync_pull`/`sync_push`) → `turn.rs`
  (what the chat agent tells the coding agent) → Settings status → README
  **Sync between computers** and `infra/README.md`. Add to `server/sync.test.mjs`
  / `server/git.test.mjs` and the sync unit tests in `sync.rs`.
- **New landing-page route or field:** `server/*.mjs` router → `waitlist/` UI →
  `server/*.test.mjs`. Keep old rows readable — tests deliberately seed an
  older schema.
- **New visual token:** `src/styles/index.css`. The window is frameless and the
  glass is pure CSS, not an OS backdrop material.
- **AI reporting / Store policy 11.16:** `ReportDialog.tsx` + `MessageItem.tsx`
  → `bridge.ts`/`types.ts` → `commands::report_message` → `reports.rs` →
  `server/reports.mjs` → the `ai_reports` table → `scripts/ai-reports.sh`.
  Keep the “include the whole conversation” toggle opt-in.
- **New release/update behavior:** `server/releases.mjs` → `server/download.mjs`
  → `src-tauri/src/update.rs` → `src/lib/types.ts` → `bridge.ts` → the update
  store/component → `server/releases.test.mjs` and the `update.rs` tests. The
  release pipeline lives in `.github/workflows/release-app.yml` plus
  `scripts/release-gate.mjs` and `scripts/merge-release-index.mjs`.
- **Store/update channel changes:** `msix/AppxManifest.xml` +
  `msix/identity.json` → `scripts/build-msix.mjs` → `update.rs` channel
  detection/`store_url` → the Store branches in `UpdatePrompt` and the update
  store → `release.config.json` `store` fields → README **Microsoft Store**.

## Hard constraints

- `harness.config.toml` is gitignored and `include_str!`d into the binary — a
  missing file is a compile error. Never commit it or a real provider key. The
  key lives server-side; the renderer must never see a secret.
- **Git credentials are scoped.** The desktop mints `scope='git'` tokens; the app
  token (`scope='app'`) is what reads chats and spends model credits. Never put
  the app token in a project, URL or agent environment. The git token lives in
  `agent-home/gitconfig` and is rotated per `device.json` id.
- **Sync is account-scoped and automatic.** Chats/pictures/projects push and pull
  in the background while signed in; the server merges, never the client. A chat
  that is streaming is never uploaded or overwritten. A different account on the
  same machine quarantines the previous chats under `accounts/<id>/`; never
  upload one account's history to another.
- **Git quotas are server-side.** 200 MB per project, 1 GB per account, 50 MB per
  push (`server/git.mjs` + `server/git-policy.mjs`). Do not remove the pre-receive
  hook; a push must be rejected before anything is written.
- Never edit generated or bundled trees: `src-tauri/target/`, `src-tauri/gen/`,
  `src-tauri/resources/pi-runtime/` (restored by `pnpm engine`),
  `src-tauri/resources/git/` (restored by `pnpm git`), `dist/`, `dist-waitlist/`,
  `release/`.
- **A push to `main` deploys production.** `deploy-waitlist.yml` ships
  hookcode.io on every push; `release-app.yml` publishes a Windows build when the
  application source changed. Do not push unless the user asked.
- **Never edit a version by hand.** Run `pnpm version:bump patch|minor|major`;
  it updates `package.json`, `Cargo.toml`, `Cargo.lock` and `tauri.conf.json`
  together. The release gate fails if they disagree, and refuses to republish an
  existing version with different source.
- **Publishing must stay non-breaking.** Installers are immutable and versioned;
  `releases.json` is swapped last. Never delete or overwrite the installer the
  current index points at.
- **The Store channel is separate.** A packaged (MSIX) build must never run the
  direct installer: it updates through the Store. `store.latest` is set only
  after Microsoft certifies that version. Store submissions are uploaded
  unsigned (`makeappx` without a cert). The MSIX manifest opts out of AppData
  virtualization for `%APPDATA%\app.hook.chat`; keep that so the two channels
  share data instead of forking it. The Store product name is **HookCode** (the
  manifest display name); the app UI stays Hook.
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
- Coding-agent runtime, RPC args, guard policy, preview → **Coding agents**
- Config keys and what is compiled in → **Configure**
- Version bumping, release gate, in-app updates → **Updates** and
  **Automatic Windows builds**
- AI reporting for users and reviewers → **Reporting AI output**
- Microsoft Store setup/submission, MSIX, Store update cadence →
  **Microsoft Store (MSIX)**
- Local data layout (`%APPDATA%\app.hook.chat`) → **Where the data lives**
- Landing page, OAuth, model proxy → **Web waitlist** + `infra/README.md`
- Coverage → **Tests**

**Keep docs in sync.** When a change alters commands, config keys, file layout,
data paths, runtime behavior or a user-visible flow, update this file and the
matching README section (and `infra/README.md` for server config) in the same
commit. Prefer a pointer to the code over a copy that will drift.
