# Hook

A family of local-first desktop products around one account. The first is
**Hook**, an AI chat app with coding agents; **Hook Workspace** — projects,
boards, tasks and documents — is the second. Tauri 2 (Rust) + React 19 +
TypeScript, one pnpm + Cargo workspace.

One model, one thinking level — baked in at build time. Sign in with the Google
account that was approved on the waiting list, and the same session unlocks the
chat window, the coding agents, and a model proxy that keeps the provider key
server-side. Chats, pictures and project code are saved to the account so the
same work continues on another computer; the provider key never leaves the
server.

> Working on the code? Start with [AGENTS.md](AGENTS.md) — commands, repo map,
> and the constraints that are not obvious from the tree.

Hook is free software under the **AGPL-3.0-only** — use it, modify it and
self-host it, personally or commercially. Running a modified version as a
network service means publishing your changes. A fork must also rebrand. See
[License](#license), [NOTICE](NOTICE), [TRADEMARK.md](TRADEMARK.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Web waitlist

The public landing page runs separately from the Tauri desktop app. Use Node
22.13+ and run `pnpm install` followed by `pnpm waitlist:dev`. Open
[http://localhost:5173](http://localhost:5173) to preview the page.

To enable signup locally:

1. Copy `.env.waitlist.example` to `.env.waitlist.local`.
2. In Google Cloud, create a **Web application** OAuth client and register
   `http://localhost:5173/api/waitlist/google/callback` as an authorized redirect URI.
   Add your Google account as a test user if the consent screen is in testing mode.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.waitlist.local`.
   Generate `WAITLIST_SESSION_SECRET` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. Restart `pnpm waitlist:dev`.

To preview onboarding without Google or saving any details, set
`WAITLIST_DEV_MODE=true` in `.env.waitlist.local` and restart `pnpm waitlist:dev`.
“Hook Me In” then opens interests directly. Choices stay in memory only; refreshing
resets the preview. This mode does not read existing signup cookies, open the
database, send progress requests, or save choices to browser storage. It works on
localhost/loopback in the Vite dev server only and is disabled in production
builds, even if the flag is set. Set it to `false` and restart to test real signup.

The onboarding screens, interests, proposed prices, and planned features use
`waitlist/content.json`. Mobile pricing paginates the feature lists to keep all
controls inside the viewport. “Hook Me In” opens Google sign-in first and saves the
verified email immediately. The flow then shows interests, pricing, and the
“You caught us a little early” confirmation. Each interest change and navigation
step saves immediately, including incomplete onboarding. A plan selection saves
its ID and price before completion is recorded separately. Pending changes are
kept locally and retried for the same signed-in account, with an unload delivery
attempt when the visitor leaves. Returning visitors resume their saved step;
older receipts require sign-in to associate new preferences with an identity.

`VITE_WAITLIST_UNLIMITED_USAGE` defaults to `false`. Set it to `true` only after the
usage policy supports the claim, then rebuild. The default copy says “More freedom
to create.” Prices are proposed preferences, and the flow takes no payment.

### Meta Pixel

The production site loads the Meta Pixel (`1156718026779225`) for ad measurement.
`waitlist/metaPixel.ts` owns the loader and activates it only in production builds,
so `pnpm waitlist:dev` never sends events to Meta. Every page load sends `PageView`.
The Google callback redirects a genuinely new signup to
`/?signup=authenticated&lead=1` (or back to the `/authorize` page it came from),
which sends the standard `Lead` event once; a returning sign-in is not counted
again. The CSP in
`server/waitlist.mjs` and `infra/hookcode.caddy` allows the pixel's script and beacon
domains, and `public/privacy.html` documents the pixel and its cookies.

Run `pnpm waitlist:test` for the API, device-login, proxy, usage, download,
private-git and conversation-sync regression checks.

### Production

The page is live at **[hookcode.io](https://hookcode.io)** on the MoonRock VPS
(`root@167.233.58.139`), next to the other sites on that box:

```
                    ┌── Caddy (scout-caddy-1, :80/:443, auto TLS)
                    │      hookcode.io
   browser ─────────┤        /                → /opt/hook-web/site  (static)
                    │        /api/*           → hook-waitlist:5173  (container)
                    │           waitlist, device login, model proxy, download
                    │                                └── /opt/hook-web/data/signups.sqlite
```

```bash
./scripts/deploy-waitlist.sh     # build → upload site (and source, if the image changed) → probe
```

#### Deploys (GitHub Actions)

A tag decides. `.github/workflows/deploy-waitlist.yml` runs on a `deploy-*` tag,
refuses it unless it points at the tip of `main`, then runs `pnpm waitlist:test` +
`pnpm waitlist:build` on a clean runner and calls the same
`scripts/deploy-waitlist.sh` over SSH with `SKIP_BUILD=1` (it reuses the artifact
the verify job built). A push to `main` only runs the checks
(`.github/workflows/checks.yml`), so a merge cannot deploy by accident and a tag
on an old commit cannot roll the site back. Deploys are serialized; a running
deploy is never cancelled by the next tag.

```bash
git switch main && git pull
git tag deploy-$(date +%Y-%m-%d) && git push origin deploy-$(date +%Y-%m-%d)
```

The prefix is the only rule; `deploy-2` and `deploy-auth-fix` work too. To
deploy without a tag — an emergency, or a server fix that cannot wait for the
next merge — run `./scripts/deploy-waitlist.sh` from the repository.

The script fingerprints what the container runs (`scripts/site-source-hash.mjs`:
the server, `waitlist/content.json`, `release.config.json`, the manifests and
`Dockerfile`) and compares it with `/opt/hook-web/.image-hash` from the last
rebuild. A copy, layout or stylesheet change therefore ships the static build
alone and leaves the API container running; only a server, content or dependency
change pays for `docker compose build`. `REBUILD_IMAGE=1` forces it locally.

Two repository secrets are required:

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | Private key of a dedicated deploy keypair; its public half is in `root@167.233.58.139:~/.ssh/authorized_keys` with the comment `github-actions hookcode.io deploy` |
| `DEPLOY_KNOWN_HOSTS` | Pinned `ssh-keyscan 167.233.58.139` output, so the runner refuses an unexpected host key |

To rotate the key: generate a new ed25519 keypair, replace the
`github-actions hookcode.io deploy` line in `authorized_keys` on the server, update
both secrets, then delete the old private key. The key is unrestricted (the deploy
script needs docker, tar and mv on the host), so treat `main` as root-on-the-VPS:
review workflow changes in PRs.

Server-side layout, the two `/opt/scout` edits that mount the site into the shared
Caddy container, and the ops commands are in [`infra/README.md`](infra/README.md).

The account API, model proxy and download endpoint are one container because the
VPS has no Node runtime; Caddy serves the static build itself, so an API failure
never takes the marketing page down. The proxy streams SSE and therefore gets
`flush_interval -1`.
Run it standalone anywhere with `docker build -t hook-waitlist . && docker run -p
5173:5173 --env-file .env.waitlist.local hook-waitlist`.

Required environment (local `.env.waitlist.local`, server `/opt/hook-web/.env`):

| Variable | Meaning |
|---|---|
| `WAITLIST_ORIGIN` | Exact public origin, e.g. `https://hookcode.io`. HTTPS only outside `localhost`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth **Web application** client; redirect URI must be `<origin>/api/waitlist/google/callback`. |
| `WAITLIST_SESSION_SECRET` | ≥32 chars, HMAC key for the flow/receipt cookies. |
| `HOOK_PROVIDER_SECRET` | ≥32 chars, encrypts the personal model keys a paid account syncs (AES-256-GCM). Generated by `scripts/deploy-waitlist.sh`. Without it `/api/provider` answers `provider_sync_unavailable` and every app keeps its key local. |
| `WAITLIST_DB_PATH` | SQLite file; `/data/signups.sqlite` in the container, `waitlist-data/signups.sqlite` locally. |
| `DEEPSEEK_BASE_URL` | Upstream chat API, default `https://api.deepseek.com`. |
| `DEEPSEEK_MODEL` | Model the proxy asks for, default `deepseek-flash`. The model field in app requests is ignored. |
| `DEEPSEEK_API_KEY` | Server-side provider key. It never reaches the desktop binary. |
| `HOOK_MODEL_ID` | Model id the app and its coding engine see, default `hook`; must match `[model] name` in `harness.config.toml`. |
| `HOOK_CONTEXT_WINDOW` / `HOOK_MAX_OUTPUT_TOKENS` | Optional limits advertised to the app; default `1048576` / `393216`. Keep `[coding]` in `harness.config.ci.toml` in step. |
| `DOWNLOAD_DIR` | Installer directory, `/data/releases` in the container. |
| `GIT_ROOT` | Bare project repositories, `/data/git` in the container; persisted under `/opt/hook-web/data`. |
| `SYNC_ROOT` | Chat pictures, `/data/sync` in the container; the index and quota are in SQLite. |
| `PORT` | Listener port, default `5173`. |

The `waitlist_signups` table stores each Google subject, verified email, optional
name, selected interests, plan preference, selected price in cents/currency/period,
current onboarding step, start/update/completion timestamps, waitlist status, and
first signup timestamp. `onboarding_events` records individual interest changes,
step changes, plan choices (with price), and completion, with server timestamps.
Retries are deduplicated and stale actions from the same browser session do not
overwrite newer actions for that field. Existing databases migrate automatically
without replacing signups. Historical prices and completion times remain null
when they were not previously recorded.
If the three credentials are missing the API refuses to start
(and the landing page still renders — the button then reports that sign-in is
unavailable). The model proxy additionally reports `503` until
`DEEPSEEK_API_KEY` is set.

Who's on the list:

```bash
./scripts/waitlist-people.sh            # table, newest first
./scripts/waitlist-people.sh --csv      # profiles, choices, prices, progress
./scripts/waitlist-people.sh --events   # individual onboarding actions as CSV
./scripts/waitlist-people.sh --count
```

It runs a read-only query inside the container, so nothing has to be installed on
the VPS or your machine.

### Approving people

Approval is a status change on the same waitlist row. The admin script runs inside
the container, from anywhere, and prints what changed:

```bash
./scripts/waitlist-admin.sh --list
./scripts/waitlist-admin.sh --approve someone@example.com
./scripts/waitlist-admin.sh --revoke someone@example.com
./scripts/waitlist-admin.sh --delete someone@example.com
```

`--approve` lets the account sign in to the desktop app and use the model proxy.
It also puts the account on a plan: `free` unless one was chosen, either
beforehand with `--plan` or later. A waitlisted row has no plan. `--revoke` sets
the account back to `revoked`, invalidates its API tokens, and
the proxy refuses its next request. Approval does not resurrect a token that was
already revoked by signing out; the user signs in again. `--delete` removes the
waitlist row, tokens, device-login attempts, onboarding events and usage
metadata. The app checks the account on launch and whenever the proxy answers
`401`/`403`, so a revoked session drops back to the login screen instead of
failing silently.

An approved account sees a **Get Hook from Microsoft Store** button instead of
the waiting-list flow. It opens the whitelisted Store listing
(`ms-windows-store://pdp/?productid=…`, built from `store.productId` in
`release.config.json`) in the Store app, and the Store installs and later
updates Hook. The website never links an installer. The direct channel still has
one: `/api/download/windows` re-checks the session and streams
`DOWNLOAD_DIR/Hook-setup.exe` for the updater of a build installed outside the
Store (see **Releasing**), so a shared link cannot bypass the approval check.

### Desktop sign-in

Hook uses the OAuth device flow, which keeps the Google client secret on the
server and needs no custom URL scheme or local callback listener:

1. the app calls `POST /api/auth/device/start` and gets a secret device code plus
   a short code like `ABCD-EFGH`;
2. it opens `https://hookcode.io/authorize?code=ABCD-EFGH` in the system browser;
3. the user signs in with Google and approves the device — only an approved
   waitlist account can do this;
4. the app polls `POST /api/auth/device/poll` and receives an opaque `hk_…` token
   once. Only its SHA-256 hash is stored in SQLite.

The token lives in `%APPDATA%\app.hook\account.json`, which every Hook product on
the machine shares: signing in to one signs in all of them, and signing out of
one signs out all of them. Each product keeps its own `auth.json` mirror so a
downgrade still starts signed in. The chat agent sends the token
as a bearer token; the bundled pi runtime receives it through `HOOK_API_TOKEN`
and references it from its `models.json`. Signing out revokes the token on the
server and closes live coding agents.

A phone signs in with its **own account sheet** instead. `GET /api/auth/config`
answers the web client id (public, and it is in every page of the site), Android
Credential Manager shows the Google accounts on the device, and
`POST /api/auth/google` checks the ID token it returns against the same
`waitlist_signups` approval the device flow uses before minting the same kind of
`hk_…` token. Nothing leaves the app for the browser, and the app asks the
server for the client id rather than carrying one build's. The device flow stays
in the phone as "Use a code instead", and it is still the only path on desktop.

### Model proxy and usage

`/api/v1/chat/completions` is OpenAI-compatible, so the chat agent and pi use it
unchanged. The app does not send a provider or a meaningful model: the proxy
injects `DEEPSEEK_MODEL`, the server key and `stream_options.include_usage`, then
relays the SSE stream byte-for-byte. `/api/v1/models` describes the single
`HOOK_MODEL_ID` model (with the configured model's context, output and image
capabilities) so the app's capability probe works.

A reply is not cut short by a clock. There is no overall or idle deadline on a
turn and no limit on how many tool round-trips it may take: a model that thinks
for minutes before its first token, or an agent working through a long job, runs
until it answers or you press Stop. The window still cannot be left waiting by a
turn that died — `finish()` turns a reply that never completed into a visible
error — but the decision to stop is yours, not a timeout's.

Every request is tagged with headers from the client:

| Header | Meaning |
|---|---|
| `X-Hook-Surface` | `chat` or `coding` |
| `X-Hook-Chat-Id` | Conversation id, so usage can be grouped per chat |
| `X-Hook-Agent-Id` | Coding-agent run id, set per spawned process |
| `X-Hook-Message-Id` | The user message this request belongs to; repeated by every call of one turn |
| `X-Hook-Client` / `X-Hook-App-Version` | Client build |

A `free` account is refused before the upstream request: `coding_not_included`
for a coding surface, and `message_limit` once 100 distinct message ids have been
seen in the last 24 hours. `usage_events` also records the plan in force, so a
later plan change does not rewrite history. A request to a personal endpoint
carries none of these headers and never reaches this service.

`usage_events` stores input/output tokens, `prompt_cache_hit_tokens`,
`prompt_cache_miss_tokens`, reasoning tokens, duration, time-to-first-token and
the status for each request. The cache hit rate is computed from the hit/miss
pair, not from a guess. Analyse it with:

```bash
./scripts/waitlist-admin.sh --usage          # per account
./scripts/waitlist-admin.sh --usage-plans    # per plan (the plan stored on each request)
./scripts/waitlist-admin.sh --usage-chats    # per conversation
./scripts/waitlist-admin.sh --usage-agents   # per coding-agent run
```

Rows are stored with UTC timestamps; the tables print them in Israel time
(`Asia/Jerusalem`, DST included).

The proxy also enforces a small per-account concurrency and requests-per-minute
limit. Revocation is checked on every request, so `--revoke` takes effect without
restarting anything.

### Web search

Both agents have a `web_search` tool. It calls `/api/v1/search` on Hook's proxy,
which forwards to DeepSeek's standalone Search API (`/v1/tools/search`) with the
server key. DeepSeek's built-in `deepseek_web_search` **server tool** cannot be
combined with the agents' own function tools yet, so this uses the same search
engine behind an ordinary tool instead.

The tool returns titles, URLs, snippets and summaries, and tells the model to
cite the URLs it uses. The chat agent calls it directly; coding agents get it
from `hook-guard.mjs` using `HOOK_API_BASE` and `HOOK_API_TOKEN`. Queries support
DeepSeek's operators (`site:`, `-site:`, `"exact phrase"`, `lang:`, `after:`,
`before:`, `-term`).

Search is billed by DeepSeek per successful request, independently of token
usage. It is not included in the token/cache totals; the proxy logs only that a
search happened and how many results came back, not the query text. The
per-account search limit is 4 in flight and 60 per minute.

### Releasing

Installers are built and published from the machine that makes the release, not
from CI:

```bash
pnpm version:bump patch                 # patch|minor|major, add --product workspace
pnpm release                            # every product whose source changed
pnpm release -- --dry-run               # build and merge the index, upload nothing
pnpm release -- --store                 # also package the MSIX and print the submit
```

`scripts/release.sh` refuses to run from anything but a clean, already-pushed
`main`, runs the checks (`pnpm typecheck`, `pnpm test:release`,
`cargo test -p hook-core`), and then, per product, builds the installer, writes
`release/latest.json` (version, commit, builtAt, size, SHA-256, source hash,
release notes), merges it into `release/releases.json`, and uploads both to
`/opt/hook-web/data/releases` over the same SSH deploy key as the website. It
prints what it is skipping: a product whose source is identical to the published
build is left alone.

The release gate (`scripts/release-gate.mjs`) is what decides that, and it still
refuses the two cases that used to fail the workflow:

| Repo state | What happens |
|---|---|
| Same application source as the published build | that product is skipped |
| Source changed, version bumped | builds and publishes |
| Source changed, same version | refuses, asks for `pnpm version:bump` |
| Source changed, lower version | refuses (no downgrades) |

Publishing never takes downloads down. The new installer goes up under its
versioned name first; the old index keeps serving the previous version until the
new one is complete, and the swap is a single `mv`. The last five versions stay
downloadable.

`.github/workflows/checks.yml` still runs the typecheck, both window builds, the
server suite and `cargo test -p hook-core` on every push that can change a
product — it is the "is main good" light, not a publisher. Nothing in CI has to
pass for a release to go out, which is why `pnpm release` runs those checks
itself before it uploads anything.

The release profile is tuned for build time — thin LTO, parallel codegen units,
and one `rlib` per product instead of the mobile `staticlib`/`cdylib` too —
because an installer is dominated by the ~200 MB of MinGit, Node and pi it ships,
not by the executable in it.

Bump the version with `pnpm version:bump patch` (or `minor`, `major`, or an
explicit version, add `--product workspace`). It updates that product's
`package.json`, `src-tauri/Cargo.toml`, the workspace `Cargo.lock` and
`src-tauri/tauri.conf.json` together: the app reports
Cargo's version, the installer is named after Tauri's, and the release manifest
refuses to publish if they disagree.

`crates/hook-core` is the one crate with no release version: it is shared by both
products, so a number of its own would be wrong for at least one of them. Each
app passes `env!("CARGO_PKG_VERSION")` to `hook_core::builder`, which records it
in `crates/hook-core/src/version.rs`; the window's version label, the update
check, the sign-in payload, the AI report and the `X-Hook-App-Version` header all
read it from there. Never call `env!("CARGO_PKG_VERSION")` inside `hook-core`
for anything user-facing — that answers with the crate's own number, and a build
that believes it is an old version offers an update forever.


### Google Cloud

The OAuth client lives in its own project so the consent screen is branded for
Hook rather than for the other sites on this box:

| | |
|---|---|
| Project | `hookcode-waitlist` (display name `Hook`) |
| Consent screen | External, **In production** — anyone with a Google Account can join, no cap |
| Scopes | `openid`, `email`, `profile` |
| Client | `Web application` → `Hook Waitlist` |
| Redirect URIs | `https://hookcode.io/api/waitlist/google/callback`, `http://localhost:5173/api/waitlist/google/callback` |
| Branding | app name `Hook`, support/contact `support@hookcode.io`, authorised domain `hookcode.io`, home `https://hookcode.io`, policy links to `/privacy` and `/terms` |

The app name is not brand-verified, so Google's account chooser says “continue to
hookcode.io” instead of “continue to Hook”. Verifying `hookcode.io` in Search
Console (a DNS TXT or the HTML file it gives you, dropped into `public/`) is what
switches that to the app name; nothing else depends on it.

To rotate the client secret: Clients → `Hook Waitlist` → add a new secret, copy it
into `/opt/hook-web/.env`, then `docker compose up -d waitlist`.

`/privacy` and `/terms` are static pages in `public/`, served through
`try_files {path} {path}.html …` and linked from the consent screen.

The landing CTA stays “Hook Me In” and starts Google sign-in. Public
copy and the usage flag are baked into the static build, so rebuild the site
after changing them.

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
into the binary with `include_str!`, so the build's endpoint and model cannot be
changed at runtime. The one deliberate override is a user's own model endpoint
in Settings (see **Plans, limits and your own model**): it replaces the provider
and model for that product only, and it is stored on the machine, never in this
config:

The production config (`harness.config.ci.toml`) points at Hook's own proxy:

```toml
[provider]
base_url = "https://hookcode.io/api/v1"
path = "/chat/completions"
api_key = ""                 # unused: the signed-in session supplies the token
reasoning_param = "reasoning_effort"
stream_usage = true
tools = true
reasoning_echo = "auto"

[model]
name = "hook"                # must match HOOK_MODEL_ID on the server
thinking = "high"

[auth]
base_url = "https://hookcode.io"
required = true              # false only for the local mock provider
```

`thinking` is sent using `reasoning_param` (mapped to `reasoning_effort` for
OpenAI-style APIs). It is never shown in the UI. Thinking-mode APIs (DeepSeek
among them) reject the follow-up request unless the assistant's
`reasoning_content` is replayed on tool-calling turns — an empty string counts.
Hook records the field each answer was streamed in and sends it back
automatically (`reasoning_echo = "auto"`).

The provider key lives on the server. The binary is built without it and sends
the signed-in user's opaque token instead, so extracting strings from the
executable no longer yields a usable model key.

Coding agents and the chat agent's instructions have their own optional
sections:

```toml
[coding]
model = ""            # passed to pi as --model; empty = the chat model
thinking = ""         # passed to pi as --thinking; empty = pi's default (medium)
max_concurrent = 3    # how many coding agents may run at once
bash_max_timeout = 3600   # seconds, enforced on every bash call
bash_min_timeout = 1

[agent]
system_prompt = ""    # empty = Hook's built-in instructions

[memory]
enabled = true
max_entries = 400        # stored entries, pinned and not
max_pinned = 40          # the ones in every prompt
pinned_budget_chars = 2400   # about 600 tokens; the block stops there
max_text_chars = 400     # longer facts are cut, not rejected
context_role = "system"  # "user" for an endpoint that rejects a trailing
                         # system message; "none" drops the live context

[compact]
enabled = true   # false leaves /compact (advanced mode) as the only way
at = 0.30        # compact once a request would spend 30% of the window
keep_turns = 3   # recent user turns kept verbatim after the summary
window = 0       # 0 = [coding] context_window; the share is measured against it
```

`[compact]` is the one place the request prefix is rewritten on purpose: a long
conversation would otherwise be replayed in full on every turn. It fires on the
first round of a turn, only when the estimate crosses the share, and it is a
model call of its own that repeats the user's message id — the free plan still
counts that message once. The share is an estimate of the window; when an
endpoint answers "too long" anyway (a model smaller than the configured window),
that turn compacts once and retries. See **Advanced mode** for how the cut is
drawn.

`harness.config.example.toml` remains a direct-provider template if you want to
build a standalone copy without the account service.

## Run

Prerequisites: Node 20+, Rust stable (MSVC toolchain), WebView2 runtime.

```bash
cp harness.config.ci.toml harness.config.toml   # production proxy config
pnpm install
pnpm app          # dev window with hot reload
```

`harness.config.toml` is gitignored so you can keep a local provider. On a fresh
clone, copy `harness.config.ci.toml` (the config a release is built with) or
`harness.config.example.toml`. The production config requires a signed-in
approved account. For UI work without the service, use the mock provider below.
The config file must exist before building — it is compiled into the binary, so a
missing file is a compile error by design.

`pnpm app` is a debug build, so it keeps its own data under
`%APPDATA%\hook-dev\` and is signed out the first time it starts. See **Where the
data lives**.

No API key yet? Use the bundled mock provider:

```bash
cp harness.config.mock.toml harness.config.toml
pnpm mock         # terminal 1 — fake OpenAI-compatible endpoint on :8787
pnpm app          # terminal 2
```

Restore the production config afterwards (`cp harness.config.ci.toml harness.config.toml`).

## Build

```bash
pnpm engine        # fetch the coding engine into apps/chat/src-tauri/resources/pi-runtime
pnpm git           # fetch the bundled git for coding agents
pnpm app:build     # the chat app's NSIS installer (runs `pnpm engine` and `pnpm git` first)
pnpm app:portable  # portable folder for the chat app, zipped

pnpm workspace:app         # Hook Workspace dev window
pnpm workspace:app:build   # Hook Workspace NSIS installer (its own engine copy)
```

Both apps share one Cargo workspace, so `cargo build` output lands in `target/`
at the repo root; the Tauri CLI still runs per app (`apps/chat`, `apps/workspace`).

Outputs for the chat app:

- `target/release/bundle/nsis/Hook_<version>_x64-setup.exe` — installer,
  ~78 MB (`pnpm release` copies it to `release/Hook-<version>-setup.exe`)
- `release/Hook-<version>-portable.zip` — `Hook.exe` + `resources\pi-runtime` +
  `resources\git`, no install

`compression: "bzip2"` is a deliberate trade. Measured on this payload (195 MB of
MinGit + Node + pi): LZMA produced 46.6 MB in 92 s, bzip2 69.9 MB in 17 s. The
installer is therefore ~24 MB larger and every build is ~75 s shorter; building
is the scarcer resource. Switch that one line back to `"lzma"` if download size
ever matters more. `bundle.useLocalToolsDir` keeps the NSIS tools in
`target/.tauri`, so they are cached with the build directory instead of
downloaded on every runner.

The same commands with `workspace:` in front produce Hook Workspace's installer
(`target/release/bundle/nsis/Hook Workspace_<version>_x64-setup.exe`, published as
`release/Hook-Workspace-<version>-setup.exe`) and
`release/Hook-Workspace-<version>-portable.zip`. Two products, two installers,
two source hashes, one `target/` directory.

The engine (Node + pi) is ~104 MB of binaries and is not in git; `pnpm engine`
copies it from the pinned `@earendil-works/pi-coding-agent` dev dependency.
`scripts/fetch-git.mjs` adds the pinned MinGit tree (~93 MB extracted) for the
coding agents' project sync. `scripts/fetch-pi-runtime.mjs` also proves the copy
can load Hook's guard before anything gets packaged.

`pnpm version:bump patch|minor|major` is the only way to change a version (see
[Updates](#updates)); add `--product workspace` for the second product.
Hand-editing one of the three files makes the app and the installer disagree.

`harness.config.toml` is gitignored so a local developer can keep a custom
provider. `pnpm release` swaps in the committed `harness.config.ci.toml`
(hookcode.io proxy, no secrets) for the build and restores yours afterwards.

## Updates

Installed copies check `GET /api/releases` at startup and every four hours. The
response is public and lists the newest version, the oldest supported version
(`minimumVersion` in `release.config.json`, deployed with the website), and the
recent releases with their sizes, checksums and dates. What Hook does with it:

- **Current** — nothing.
- **Behind, above the floor** — a dismissible banner above the chat offers the
  new version. "Later" hides it until the next launch.
- **Below the floor** — a blocking dialog. This is the security lever: raise
  `minimumVersion` and older builds stop working as soon as the website deploys,
  without rebuilding the app. The server clamps a floor above the newest
  published build to that build, so a typo cannot brick everyone.

A packaged Microsoft Store build uses its own pair (`store.latest` /
`store.minimumVersion`) because certification lags behind direct releases; see
**Microsoft Store (MSIX)** below. The live config is:

```json
{
  "minimumVersion": "0.1.0",
  "store": { "latest": "0.3.9", "minimumVersion": "0.1.0" }
}
```

`store.latest` stays empty until Microsoft certifies the named version; an empty
value means Store builds are never told an update exists. Raise
`store.minimumVersion` only to force Store installs below it to update. The
Store's own install has a constraint the direct channel does not: see
[Updating a Store install](#updating-a-store-install).

"Update now" downloads the installer with the signed-in token, checks it against
the published SHA-256, and hands it to the NSIS installer in passive update mode
(`/P /UPDATE /R`). The installer replaces Hook and starts it again; chats,
projects and the coding engine stay on disk. There is no signing key to manage
and no separate update channel: the same account gate that protects the download
protects the update. The installer lands in `%TEMP%\hook-update\<version>\` and is
replaced by the next update.

A signed-out build still checks for updates (the index is public). Installing
asks for sign-in first, because the installer download requires an approved
account. Builds older than 0.1.1 predate the updater, so the first move to this
release is still a manual download; everything after it is one click. `release.config.json` is the only file to edit to force updates:

```json
{ "minimumVersion": "0.1.0" }
```

`0.0.0` never forces an update. The public history lives at
`https://hookcode.io/api/releases`; the desktop updater uses the same data, and
`/api/download/windows?version=` pins an exact build. The website links the
Microsoft Store listing instead of an installer.

## Reporting AI output

Every completed assistant reply has a **Report** action, in the chat window and
in a product's docked chat alike — the dialog and the action are part of
`packages/chat`, and a product that shows generated text supplies the handler
(`ChatTransport.report`); without one the action is hidden rather than shown and
broken. The dialog sends the reply, a reason, an optional note, and — only when
“Include the whole conversation” is ticked — the current chat's messages, to
`POST /api/reports` with the signed-in token. Reports are stored in the `ai_reports` table and the
privacy policy records exactly what a report contains.

Review and resolve them on the server:

```bash
./scripts/ai-reports.sh --list
./scripts/ai-reports.sh --show 12
./scripts/ai-reports.sh --resolve 12
```

The Store requires this mechanism (policy 11.16); see **Microsoft Store
(MSIX)** below. Workspace will need the same listing disclosure and Partner
Center declaration before it can be submitted.

A preview can also show something a *person* wrote — a task's comments, a
document — and that is user-generated content, which App Store guideline 1.2
and the Play Console's UGC policy require a flag for. The same dialog does it
(`ReportContentDialog`): same reasons, same review queue, `subject_kind`
`"content"` and a `target` naming the entity instead of a message id, with the
comment or document as the evidence. `./scripts/ai-reports.sh --list` marks
which kind each row is.

## Microsoft Store (MSIX)

Hook also ships as an MSIX through the Microsoft Store. Microsoft signs that
package with its own certificate, so Store installs never see a SmartScreen
prompt even though the direct installer is unsigned. This is a second channel,
not a replacement: the direct NSIS installer and the custom updater keep
working, and the same source will later build macOS and Linux packages.

### One-time setup (Partner Center)

1. Create a free developer account at
   [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com). A
   Company account needs a D-U-N-S number (or incorporation/registration
   documents) and a business-domain email; an Individual account verifies with
   an ID and selfie. Both are free.
2. Partner Center → Apps and Games → New product → **MSIX or PWA app** → reserve
   the name `HookCode`.
3. On the product's **Package identity** page, copy the Identity Name (for
   example `BenTimor.HookCode`), the Publisher (`CN=...`) and the Store ID
   (`9N...`).
4. Fill `msix/chat/identity.json` with those values and a publisher display name.
5. Put the Store ID in both places that carry it: `harness.config.ci.toml` for
   the packaged app, and `release.config.json` for the website.

   ```toml
   [update]
   store_id = "9N..."
   ```

   ```json
   { "store": { "productId": "9N...", "latest": null, "minimumVersion": "0.1.0" } }
   ```

The reserved product name is **HookCode**; the MSIX display name matches it, while
the app's own window and chat UI stay branded **Hook**. Until step 4,
`node scripts/build-msix.mjs` prints these instructions and exits without
packaging, so a direct release is never blocked by an unconfigured Store
identity.

The listing is whitelisted, so it opens only for accounts Microsoft has approved.
That is why the website shows its button on the approved screen and nowhere else:
`/api/waitlist/status` returns `store: { productId, url }` from
`storeListing()` in `server/releases.mjs`, which reads the id out of
`release.config.json`. The packaged app keeps its own copy in
`harness.config.ci.toml`, because a Store build cannot ask the server which
listing it came from.

### Build the package

```bash
pnpm app:msix      # fetch the engine, build Hook.exe, package the MSIX
```

The result is `release/Hook-<version>-x64.msix` (about 84 MB with the bundled
engine and git). CI does not package the Store build: it is made here, on
demand, from the commit that was published, and submitted when you decide to
(`pnpm release -- --store` packages it and prints the submit command). The
package is deliberately unsigned: Partner Center re-signs Store submissions, and
signing it yourself with a self-signed certificate only breaks the upload. For
local sideload testing, pass `--sign dev.pfx --password …` to sign with a
development certificate.

A package version has four numeric parts, so the script writes `<semver>.0`
(0.2.1 → `0.2.1.0`) and the manifest is not edited by hand. Every Store
submission needs a version higher than the one you published before it, which a
`pnpm version:bump patch` per submission already gives you.

The package contains `Hook.exe` plus `resources/pi-runtime` and `resources/git`,
and declares `runFullTrust` (the coding agents spawn a bundled Node runtime and work in the
user's project folders) and `unvirtualizedResources`. The latter opts
`%APPDATA%\app.hook.chat` out of MSIX AppData virtualization, so the Store and
direct builds share chats, sign-in and project notes — and uninstalling the
Store app does not delete them. It needs the Evergreen WebView2 Runtime, which is
preinstalled on Windows 11 and on Windows 10 machines with Edge; the Store
listing states the requirement.

`makeappx` is taken from the newest installed Windows SDK, which must know the
`uap17` namespace the manifest uses (the 10.0.26100 SDK does; anything from
Windows 11 24H2 on does). An older SDK rejects the manifest instead of producing
a package that fails the same way at install time.

### The taskbar icon

A packaged app's taskbar, Start and search icon is drawn on a square *plate*
filled with `uap:VisualElements/@BackgroundColor` unless the package carries
the per-size, unplated AppList assets. Hook's mark is a rounded square, so the
plate showed through its four corners: with `BackgroundColor="transparent"`
that is the user's accent colour, which looked like a red ring around the
taskbar button on a red-accent machine. The manifest therefore names the mark's
own `#20201E`, and `pnpm msix:icons` renders
`Square44x44Logo.targetsize-<n>[_altform-unplated|_altform-lightunplated].png`
(14 sizes × 3 themes) from `apps/<product>/src-tauri/icons/icon.png`. Those
files are part of the icon set, not a build output: `tauri icon` does not make
them, so rerun `pnpm msix:icons` whenever the mark changes. The names follow the
`Square44x44Logo` attribute — rename one and rename the other.

### Updating a Store install

MSIX never services a package that is in use. An update that finds Hook running
fails with `ERROR_PACKAGES_IN_USE` (`0x80073D02`) — and the Store reports that as
a failed update with no reason at all, which reads as "try again". Closing Hook
is what makes it work, because the package's files (the exe and the bundled
`resources/pi-runtime` and `resources/git` that agent subprocesses load) are
locked while it runs. Two things keep that from being the user's problem:

- The manifest declares `<uap17:UpdateWhileInUse>defer</uap17:UpdateWhileInUse>`
  in `<Properties>`. Windows then **holds** the update and finishes it the next
  time Hook closes, instead of failing. Honoured on Windows 11 24H2 (build
  26100) and later; older Windows ignores it, so it is listed in
  `IgnorableNamespaces`.
- The in-app Store button closes Hook before it hands over
  (`open_store_update` → `update::open_store_for_update`), so the deployment
  never meets a locked package on any Windows version. `on_exit` stops the
  coding agents and the preview server first, which is what actually releases
  the package files. Reopening Hook is the user's job — Windows will not
  relaunch a full-trust app after a Store install.

Neither reaches an install whose package predates the change; that one update
still needs Hook closed by hand. `scripts/msix.test.mjs` fails if a template
loses the element, the namespace or a placeholder the packager fills.

### Store policy 11.16: live generative AI

Hook replies and coding-agent steps are created live by a model, so the Store
requires four things — all but the Partner Center declarations are handled by
the app:

| Requirement | Where |
|---|---|
| Disclose live generative AI in the listing | description draft below |
| Declare it in Partner Center | Properties → “This product incorporates generative AI features” |
| Let users report inappropriate output | **Report** on every assistant reply, with an optional “include the whole conversation” toggle |
| Act on reports | `./scripts/ai-reports.sh --list`, `--show <id>`, `--resolve <id>` |

The endpoint is `POST /api/reports` (approved accounts only). It stores the
reported reply, reason, optional note, optional transcript, account and app
version in the `ai_reports` table; the privacy policy documents it. The reply is
always included, so the dialog warns against reporting secrets.

### Store listing draft

The Partner Center copy is kept as plain text under `msix/chat/store/`, one file
per field, ready to select and paste without Markdown or rich text:

- `short-description.txt` (228 characters; limit 256)
- `full-description.txt` (about 5,700 characters; limit 10,000)
- `feature-bullets.txt` (one sentence per line; each under 200 characters)
- `release-notes.txt` (0.5.0 "What's new in this version"; 1,439 characters,
  limit 1,500)

These are the 0.5.0 listing and release notes. Search terms: AI chat, coding
agent, AI assistant, code assistant, developer tools, cross-device sync,
project sync. ("ChatGPT import" is tempting but it is someone else's trademark
in a keyword field - leave it out unless you want to argue about it.)

## Hook Workspace

The second product. A project holds boards of tasks, Markdown documents,
roadmaps of milestones and the people they are shared with; folders organize
them, and can nest. It is its own installer
(`apps/workspace`, identifier `app.hook.workspace`) with the same window chrome,
the same account and the same chat beside it.

Home surfaces pending invitations before the getting-started actions, with the
project name, inviter profile when available, and Accept/Decline buttons. Accept
opens the joined project. Home also lists existing projects and offers Create a
project and Plan with Hook. Home and Invites sit near the top of the rail;
the invite count stays visible while working inside a project.

One rail, one tree: projects read as special folders (they are the unit of
sharing), and everything inside one — nested folders, boards, documents — is a
row under it. Nothing lives in a second column. Right-click anything in the
tree to rename, delete, create inside it, or move it to another folder; the
same menu opens from the plus on a project or folder. A board opens as a table
with one task per row, the board's own columns across, and a grip to reorder
the rows (the kanban is the second tab, not the only view).
The project overview highlights boards and documents, with a plus beside each
heading for editors and managers. The People button opens members and invitations.
Below Boards and Documents, Quick access shows favorites first, then recently
opened and edited work without duplicates. Favorites and recently opened items
are saved on this device for the signed-in email and project; recently edited
uses the items' server-provided edit times. Quick access tiles load board tasks
or formatted document content for a preview when the tile comes into view.
Creating a board opens a **template picker** grouped for personal use, study,
product/engineering and business, plus a blank board. Templates are data, not
features: each one is just a name suggestion, a set of properties, a default
view and example rows. A to-do list, assignment tracker, roadmap, sprint, CRM
and content calendar are all the same board underneath.
`apps/workspace/src/lib/boardTemplates.ts` owns the presets.

A board's columns are **properties**. From **Properties** in the board header an
editor can add, rename, reorder, hide or remove them, and add/rename/reorder/
recolour/remove choice and status options. Supported types are title, text, long
text, number, checkbox, select, multi-select, status, person, date, date & time,
timeline, progress, URL, email and phone. Values live in the task's `fields`
object (status and assignees stay first-class columns), so adding a property
never requires a new database table. Simple boards only show the properties
their template chose; the table no longer invents an assignee column.

Opening or creating a board task shows its details, description and comments in
a full task view with a properties sidebar for status, multiple assignees and
dates. The description uses the document formatting toolbar and automatically
saves edits. Back to board returns to the selected board view. **Filter**
narrows both the table and board views by status or any select column (such as
Priority), and can combine several columns. The board view can group by any
status or select property. The last row of the table is an inline quick add:
click **New task**, type a title and press Enter to append it without opening
the task view.

The important structural decision: **the workspace service is the product; the
window is a client.** `server/workspace.mjs` owns projects, memberships,
invitations, folders, boards, tasks, comments and documents, and enforces roles
on every request. That is what lets Hook's chat agent do the same work on a
machine where Workspace is not installed, and it is why there is no local merge
to write: a device applies `/api/ws/changes` and converges.

Roles: `viewer` reads, `editor` creates and edits, `manager` also invites
viewers and editors, `owner` deletes the project and transfers ownership. A
manager cannot mint another manager, and ownership only moves to someone who
accepted the invitation and is already a manager — the Workspace dialog says
that it is permanent and cannot be undone.

- **Work is assigned by account, or by address before the account joins.** A
task holds an `assignees` list, so several people can own it; `assignee` mirrors
the first entry for older clients and tools. Each value is a member's account
subject. Someone invited has no subject on the project until they accept, so a
task assigned to them carries the address the invitation went to, and that is
all anyone sees of them. The members endpoint returns those addresses under
`pending` (for the people who can invite, like the invitations list); accepting
the invitation rewrites every matching entry to the account, each with a new
`seq`, so it becomes their name on every board and every device. An address that
already belongs to a member is stored as the subject in the first place, and
rows written before this rule are adopted when the service starts.

- **One cursor.** Every workspace row carries `seq` from one global counter;
  `GET /api/ws/changes?since=N` returns rows in projects the caller belongs to,
  tombstones included, bounded by rows and bytes. Clients keep the last `seq`.
- **Documents are Markdown.** The buffer is the document, so there is no
  round-trip to lose formatting. A formatting toolbar adds headings, lists,
  checklists, links, inline styles, code blocks, dividers and Markdown tables.
  The formatted editor is the default and lets people edit table cells directly.
- **Formatting beyond Markdown is a directive, not HTML.** Inline styles are
  written in the text itself — `:red[…]`, `:green[…]`, `:blue[…]`, `:purple[…]`,
  `:mark[…]`, `:underline[…]`, `:kbd[…]` — and a callout is a block:
  `:::note[Title]` … `:::` (also `tip`, `warning`, `danger`). A label holds
  ordinary Markdown, so `:red[a **bold** word]` works, and blocks nest by adding
  a colon (`::::note[…]` around `:::tip[…]`). A word that is not a registered
  rule, an empty label and a block word used in a sentence all stay exactly as
  typed, so prose like `localhost:8080` is never reformatted. Raw HTML is not
  rendered at all — it is shown as the text it is — which is why every surface
  (the Workspace window, the chat side panel and the phone) draws the same
  document the same way, without a sanitizer.
  **`docs/document-markdown.md` is the syntax**, written for a person and for
  the chat agent at once: the rules, where each works, what stays literal, the
  traps and the document options. The agent reads it on demand through the
  `document_markdown` tool instead of carrying it in every prompt, and
  `pnpm test:markdown` fails if a registered rule is missing from it.
  `packages/markdown/src/rules.ts` is the whole registry: one entry names a
  word, an element and a class, and the live editor, the toolbar and every
  preview pick it up together. Reading draws the page with `.hook-doc`
  (`packages/ui/src/tokens.css`), whose numbers are the formatted editor's, so
  the chat side panel, the phone sheet and the dashboard tile show a document
  the way the Workspace window does — direction and line breaks included.
  Editing behaves the way a word processor does:
  inline markup is invisible, so an edit only ever changes the text it wraps and
  the markers are put back around whatever survived. The caret stops at the
  content edge of a run — never on a marker — so an arrow key always crosses a
  visible character, a click at the end of a run lands inside it (typing
  continues the run), and Backspace removes a character rather than the colour.
  Delete the whole content and the construct goes with it. A callout or a picture is a unit instead: deleting at
  its edge removes it. Inline HTML from older documents
  (`<span class="hook-color-red">`, `<mark>`, `<u>`) is rewritten to the
  directive syntax when the service starts; a code sample keeps its HTML.
  One upstream trap to know: a fenced code block inside a callout must not
  contain a line of nothing but colons, because that closes the callout early.
  Give the callout one more colon than the sample needs.
  Use **Add image** in a document or task description to insert a web image or
  select a PNG, JPEG, GIF, or WebP file. You can also paste an image from the
  clipboard or drop an image file onto the editor. Embedded images sync with
  the Markdown and count toward its 512 KB limit. Large files are
  resized to fit, and animated GIFs may become still images when resized.
  In the formatted editor, Backspace and Delete remove an adjacent image as a unit.
  Hover over a web link for its address and open action, or Ctrl-click it to open.
  Document options also offers Markdown source editing, left-to-right or
  right-to-left text direction (also a toolbar toggle), and deletion. The
  direction is stored with the document, applied to the editor and every
  preview, and the chat agent can set it through `workspace_documents`.
  A write carries the revision it was based
  on; a stale one is refused with the current copy rather than silently overwriting
  someone else's paragraph.
- **A roadmap is a project item; milestones live inside it.** A roadmap sits in
  the tree and the project overview like a board or document. It opens as a
  horizontal timeline where each milestone is a large circle carrying its date,
  status, title and description preview, connected by a line and scrolling left
  to right; the page can also be dragged sideways. Clicking a circle opens a
  Motion-animated drawer for editing that milestone, and the New milestone
  button or dashed circle at the end adds another one. Milestones themselves
  are not tree items.
- **Comments know how they were written.** `author_kind` is `user` or `agent`,
  and an agent comment carries the conversation it came from, so a teammate sees
  "via Hook agent" instead of mistaking it for something the user typed. The
  author can edit or delete their own comment; a manager or owner can edit or
  delete any comment on the task.
- **The chat agent can do everything a person can, except transfer ownership.**
  `workspace_projects`, `workspace_folders`, `workspace_boards`,
  `workspace_tasks`, `workspace_comments`, `workspace_documents`,
  `workspace_roadmaps`, `workspace_milestones`, `workspace_members`,
  `workspace_invites` and `workspace_preview` are ordinary
  chat tools (`crates/hook-core/src/workspace.rs`) that call the account API with
  the user's token, so the server checks the user's real role. `document_markdown`
  is the one that answers from the binary: the dialect's reference, so a style it
  writes is a style documents can render.
- **Previews.** `workspace_preview` puts a task, board or document in the preview
  panel. It is a second kind of preview next to the HTML page a coding agent can
  show, and the panel renders it directly instead of in an iframe.
- **Folders are rows, not a client feature.** A folder carries a name, an
  optional parent and a position; a board, a document or a roadmap carries a
  `folderId`. Deleting a folder deletes what it holds — nested folders, boards with their
  tasks and comments, documents, roadmaps and their milestones — each row a tombstone of its own, and the
  dialog counts what goes before it happens. Two people see the same tree
  because it is the project's, not theirs.
- **The window is online-first.** The server is the source of truth, so the app
  keeps an in-memory copy and applies `/api/ws/changes` every five seconds while
  visible (and on focus). Nothing on disk can drift from the account, and there
  is no merge to get wrong. Offline work is the next step, not a promise made
  here.
- **The chat sits beside the work.** A collapsible right-hand panel embeds the
  same conversations as Hook (`packages/chat`). It is the chat window at 380px,
  not a reduced panel: the same greeting and suggestions on an empty
  conversation, the same thread and composer, and one button that covers the
  column with the conversation list — search and new chat included — because a
  panel inside a panel cannot show both. The thread, the messages and the
  composer are the ones the chat window renders, so there is one chat surface
  to fix, not two. It has no preview panel; a preview is a
  wide, page-shaped thing, and the dock is deliberately narrow. The window tells
  the backend what it is showing — project, board, open task, selected text — and
  that rides on the next request as context, so "summarise this board" means the
  board on screen. The context is never stored in the chat.
- **Its own download slot.** `/api/releases/workspace` and
  `/api/download/windows?product=workspace` serve the Workspace installer; the
  chat app keeps its historical URLs. Installers are uploaded under versioned
  names and the index is swapped last, exactly like the chat app.

## Hook on a phone

HookCode on a phone (`apps/mobile`, identifier `app.hook.mobile`) is the third
product and the first one that is not a desktop installer. It is the same
conversation and the same account, with the chat agent's hands in Hook
Workspace — and nothing that needs a folder on a disk.

It is the same code, not a second implementation:

- **The backend is `hook-core` with `Capabilities::mobile()`.** Workspace tools,
  memory, `web_search` and `search_past_chats` are on. `coding_agents`,
  `projects` and `preview_pages` are off, and the prompt sections that describe
  them — `## Projects` and `## Preview panel` — are removed before the model sees
  them, so the agent is never told to open a folder it cannot reach. The
  `## Coding agents` section stays, with one added line: this device is a
  controller, so it starts and steers work on a computer but never runs an agent
  itself.
- **The turn runs on the device.** The same `turn.rs` loop, the same tools, the
  same `/api/v1` endpoint. Nothing server-side was added to make this work, and
  there is no second system prompt to keep in step. The trade is that iOS
  suspends the app: a reply that is still streaming when the screen locks is
  persisted as it stands and finishes as an error you can retry, rather than
  completing in the background.
- **The chat surface is `packages/chat`.** `mobile.css` is the phone's re-skin of
  the same thread and composer, the way `dock.css` is the 380px re-skin. The
  composer uses the WebView's own `<input type="file">`, which opens the camera
  or the photo library without a plugin.
- **The home screen is a new conversation.** Like the desktop window, the phone
  opens on a greeting and the composer; sending starts the chat and the same
  screen becomes its thread. The archive is one tap away behind the history
  button, on the home screen and in the conversation header, with the same
  pin, rename and delete actions a long-press would show if a phone had
  somewhere to put a menu.
- **Coding agents are an Advanced action, here as on the desktop.** The **Code on
  <machine>** chip on the home screen, the archive's coding-agent rows and the
  conversation that would show one all follow the account's advanced mode. With
  it off the chat agent is the way in: it has the agent tools and the machine
  list, so it decides whether a machine is needed and starts the run itself. A
  phone does not offer a second, simpler path into the same agent.
- **The Android back gesture is navigation, not close.** `src/lib/back.ts`
  keeps a small layer stack: a report dialog closes first, then a sheet, then
  the thread or the list. Only the home screen lets the gesture leave the app,
  and `capabilities/default.json` grants `core:app:allow-exit` because
  registering a `back-button` listener turns off the app plugin's own close.
- **The keyboard takes the bottom of the screen, not the title.** Since
  targetSdk 35 Android runs an edge-to-edge app without resizing it for the
  keyboard, so the system pans the whole page instead. `plugins/mobile-shell`
  pads the window by the IME inset; the header stays put and only the thread
  gives way. `Thread` also watches its own height, so a reader at the bottom
  stays pinned when the keyboard opens.
- **Signing in fills the list in place.** `init` ran before there was a token,
  so its list is empty; `hook://auth` reloads chats and wakes the sync engine
  (which the mobile store used to ignore), and `hook://sync` reloads again when
  the background pull applies the desktop's conversations. No restart needed,
  and a chat streaming on this device is never replaced by the account's copy.
- **The preview is a sheet.** `workspace_preview` already returns the board,
  task or document as JSON, and `packages/chat/src/preview` draws it. The
  desktop puts that in a 440px column; a phone has nowhere to put a column, so
  the same components come up from the bottom. `preview_pages` is off locally
  because the HTML page a coding agent writes is served from a project folder
  this device does not have — which is exactly why `Capabilities` separates the
  two. A page from a computer arrives over the relay as a ticket URL and is drawn
  in the same sheet.
- **Signing in is the device flow, unless the device has a sheet of its own.**
  The desktop asks for a code, opens the browser, and polls. A phone calls
  `GET /api/auth/config` for the web client id, opens Android's Credential
  Manager sheet (`plugins/google-signin`), and posts the ID token to
  `POST /api/auth/google`, which mints the same app token under the same approval
  rule. There is no deep link and no second account flow. The token belongs in
  the OS keystore, not in a file the way `account.json` works on Windows.
- **No installer.** Xcode and Gradle build it; the App Store and the Play
  Console distribute it. `scripts/release.sh` does not touch it, and
  `scripts/products.mjs` marks it `kind: "mobile"` so nothing assumes an NSIS
  bundle exists.

A phone cannot run a coding agent: iOS forbids executing a bundled interpreter
and has no background execution to speak of, and Android only allows it through
machinery (a userland in the app's storage, or a bundled node in the native
library directory) that turns the app into a different product. Coding agents
stay on a computer that is on; the phone is where you start them, read the
progress, approve a question and steer them.

## One account, several products

Hook is a family of products that share one account, and the account is the
family's centre of gravity:

- **One sign-in.** `%APPDATA%\app.hook\account.json` holds the session and this
  installation's device id. Any product reads it at launch, so installing the
  second one does not ask again. Signing out writes an empty session back, which
  signs out every product — it is an account decision, not a product one.
- **One device id per machine.** The server rotates a git token per
  `(account, device)` pair, so two products sharing an id look like one computer
  rather than two. Only the chat app mints git tokens; Workspace never does, so
  they cannot revoke each other. The account also keeps a small **machine
  registry** (`/api/devices`): the name, platform, app version, capabilities and
  last-seen time. No conversation or project content lives there.
- **One relay.** Every running product holds an outbound WebSocket to
  `/api/relay`. Hook and a headless install are hosts; Hook Workspace and the
  phone are controllers. The phone can start and watch work on a computer
  without that computer accepting an inbound connection.
- **Capabilities, not forks.** The backend is a single crate (`hook-core`). A
  product passes `Product` and `Capabilities` to `hook_core::builder`; the chat
  agent's prompt and toolset are trimmed to what that product can honour. Hook
  Workspace, for example, has no preview panel, so its agent is never told
  about one.
- **Capability behind the API first.** Anything a product can do is an endpoint
  before it is a button, which is what makes a second product usable through
  the chat agent alone — even when it is not installed.

Products share `packages/ui` (tokens, chrome, primitives) and `packages/chat`
(the chat surface), so "the same family" is enforced by the build.

## Plans, limits and your own model

One column decides what an account may do: `waitlist_signups.plan`, one of
`free`, `plus` or `pro`. The waitlist itself is unchanged: a row that has not
been approved has **no plan** and cannot sign in. Approval is what assigns one,
and with no choice made that plan is `free`; every account that was already
approved before plans existed starts free on the migration. Assigning a plan
is a single row:

```bash
./scripts/waitlist-admin.sh --plan someone@example.com pro
./scripts/waitlist-admin.sh --plan someone@example.com free
./scripts/waitlist-admin.sh --plans
```

The app learns the plan from `/api/auth/me` and re-checks it every minute while
it is open (and when the window gains focus), so a change takes effect without a
restart. The server is the authority on every request; the client-side checks
exist so the user reads a sentence instead of an HTTP error.

### The free plan

- **No cloud sync.** Conversations, projects, memories, pictures and code
  repositories stay on the computer. The sync and git endpoints refuse the
  account (`sync_not_included`), and the sidebar marks each chat as not in the
  cloud. `DELETE /api/sync/account` still
  works, so someone who moved to free can delete what was already stored.
- **100 messages per rolling 24 hours.** Counts user messages, not model
  requests: every call of one turn (tool round-trips included) carries the same
  `X-Hook-Message-Id`, and the proxy counts distinct ids. Regenerating or editing
  a message does not spend a second slot. The window rolls, so nothing resets at
  a wall-clock hour; `/api/auth/me` reports `quota.resetAt`.
- **No coding agents or remote control.** The backend refuses to create one, the
  chat agent's toolset omits the agent tools, and the proxy refuses
  `X-Hook-Surface: coding`. Running work on another machine is also paid-only,
  and needs cloud sync on.
- **Normal chats, Hook Workspace and integrations are unaffected.** Workspace
  data lives on the account by design; the free plan does not restrict it.

A free account that sets its own model endpoint (below) is not metered by Hook
and may use coding agents.

### Cloud sync is an account switch

A paid account may turn sync off in **Settings → Advanced** (Hook), the Settings
sheet (HookCode) or the Settings dialog (Hook Workspace). The switch is stored on
the account, not in a product's settings file, so turning it off in one product
turns it off in all of them. While it is off the sync endpoints refuse that
account (`sync_disabled`), nothing new is uploaded, and every conversation is
marked **not in the cloud** — the mark explains why when clicked. Already-synced
data stays on the account until it is deleted. While it is off the live relay
refuses the account too, so no other device can reach this machine's agents.
`DELETE /api/sync/account` remains available.

The personal model endpoint follows the same switch: while sync is off (or on
the free plan) `/api/provider` refuses the account and the key stays on the
device that typed it. See **Your own model endpoint**.

### Your own model endpoint (all plans)

Settings has a **Model access** section: an OpenAI-compatible base URL (for
example `https://api.openai.com/v1`), an API key and a model name. **Load models**
asks `GET <base>/models`, and the model field is a searchable list that still
accepts a typed name, because a gateway may not implement `/models` or may return
the wrong set.

- **Stored locally, then shared if the account may sync.** The key is written to
  that product's `settings.json` (`%APPDATA%\app.hook.chat\settings.json`, the
  Workspace folder, or the phone's app container). A **paid account with cloud
  sync on** also gets one copy on the account
  (`account_provider`, `server/provider.mjs`), so the phone and Hook Workspace
  use the endpoint without the key being typed again. The other two cases — the
  free plan and an account whose sync switch is off — keep it on the device that
  typed it: those routes answer `sync_not_included` / `sync_disabled`, exactly
  as the sync routes do.
- **Encrypted at rest.** The account never stores the key in the clear. It is
  AES-256-GCM ciphertext whose additional data is the account subject, with the
  key derived (HKDF-SHA256) from the deployment's `HOOK_PROVIDER_SECRET`; a
  database row is useless without that secret, and a row copied to another
  account cannot be opened. Without the secret the service refuses to store one
  and every app keeps its key local. It is never logged, never attached to an
  analytics event, and `GET /api/provider` returns metadata only — the key has
  its own `no-store` route, read only by a device that is adopting it.
- **Last write wins, and a clear travels.** The changing device sends the
  timestamp it recorded when the endpoint was saved or removed; an older stamp
  never overwrites a newer one, and removing it on one device removes it on the
  others (the row keeps a tombstone with its fields emptied). Syncing follows
  `sync.json`'s cycle: save on the phone, and the next cycle adopts it on the
  computer and asks the new endpoint what its models can see.
- **A key belongs to the account that typed it.** `settings.json` records which
  account the endpoint was entered or adopted under. If someone else signs in on
  the same computer, the endpoint keeps working there — it always has — but it is
  neither uploaded to that account nor replaced by it. A key written before this
  was recorded is claimed by the first account that syncs it, so an endpoint
  someone already had still reaches their phone.
- **The app talks to it directly.** Chat turns and coding agents send the model
  request to that endpoint with that key. Hook's proxy never sees them, which is
  why the free message limit does not apply and why coding agents become
  available to a free account.
- **Hooked in everywhere it matters.** `ProviderTarget` in `provider.rs` resolves
  one destination per turn: Hook's service or the personal endpoint. The chat
  turn, the coding engine's `models.json` (`$HOOK_PROVIDER_TOKEN`, no Hook
  headers), the capability probe and the model list all use the same resolution.
  Removing the provider goes back to Hook's models.
- **Disclosed where it is entered.** The Settings copy states where the key is
  stored, whether the account is sharing it, that it only goes to that endpoint,
  and what turning cloud sync off means for it.
- **On Unix the settings file is `0600`**, because a key is a secret. On Windows
  `%APPDATA%` is already per-user, and on a phone the file is in the app's own
  container.

### Analytics

`usage_events` records the plan in force with each proxied request, so usage can
be read by plan. A personal endpoint never reaches the proxy, so the app reports
the facts the proxy cannot see to `POST /api/events` as one of a fixed set of
kinds — `byok_saved`, `byok_removed`, `byok_turn`, `byok_models_loaded`,
`quota_blocked`, `coding_blocked_free`, `sync_enabled`, `sync_disabled` — plus
the product and the app version. No message, path, endpoint or key is stored. To
see it:

```bash
./scripts/waitlist-admin.sh --events       # counts by kind and plan, then the last 20
./scripts/waitlist-admin.sh --plans        # accounts per plan, and how many turned sync off
./scripts/waitlist-admin.sh --usage        # token usage, now with PLAN
./scripts/waitlist-admin.sh --usage-plans  # usage grouped by the plan stored per request
```

## Where the data lives

```
%APPDATA%\app.hook\
  account.json             the signed-in account, shared by every Hook product
                           on this machine (signing in to one signs in all)
  memory\                  what the chat agent remembers, one file per account,
                           shared by every product (see **Memory**)
    owner.json             the account last in use, so the list does not empty
                           itself on sign-out
    <account>.json         the entries: text, kind, pin, source chat, revision

%APPDATA%\app.hook.chat\      Hook's own data
  chats\<id>.json          one readable JSON file per conversation; a
                           `"kind": "coding"` file is a coding-agent chat and
                           stays on this machine
  trash\                   undoable deletions
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
`hook-dev` folders instead, one level deeper, so it has its own sign-in, device
id, chats, sync cursor and agent home. Two live Hooks that shared a folder would
write over each other — the second one to start turns a running coding agent's
reply into an error (`coding.rs::recover`), the sync cursor flips back and forth,
and the relay sees one machine connected twice. Signing in there registers a
second machine on the account under the same computer name, so rename the dev
one in Settings. `HOOK_DATA_DIR` picks the folder explicitly, for a debug build
that does have to read the installed data; delete `%APPDATA%\hook-dev\` to reset
it.

Hook Workspace writes to `%APPDATA%\app.hook.workspace\` and reads the same
`%APPDATA%\app.hook\account.json`, so the two products never ask for a sign-in
twice; its cached data and the service it talks to are documented in
**Hook Workspace**.

The Microsoft Store (MSIX) build writes to the same `%APPDATA%\app.hook.chat`
folder: its manifest opts out of AppData virtualization so Store and direct
installs share chats and sign-in. In-app updates download installers to
`%TEMP%\hook-update\`; nothing else is written outside this folder. A debug build
is not part of either channel; it uses `%APPDATA%\hook-dev\` above.

## Sync between computers

A paid account keeps the whole workspace in step without a button, unless the
account has switched cloud sync off (see **Plans, limits and your own model**).
A free account never syncs. Several independent mechanisms are at work:

- **Conversations.** Each device pushes changed chats to `/api/sync/chats` and
  pulls everything newer than its cursor from `/api/sync/changes`. The server is
  the only merger, so every machine converges on the same answer: messages are
  unioned by id in transcript order (a tool result stays next to the call that
  asked for it — creation time is not message order, because the memory frame
  is written at the top of a chat although it is created after the question),
  a finished copy beats a stale in-flight one, titles and pins
  follow the newer chat, a deletion is a tombstone, and an explicit restore
  revives it. A chat that is streaming is never uploaded, and never overwritten:
  the check is on the copy **on this machine**, because the incoming copy cannot
  show a turn that has not been uploaded yet. Before that fix, the account's
  older copy could land on top of a reply mid-stream, the reply would be lost,
  and the window waited forever for a message that no longer existed. Pictures travel by SHA-256 through `/api/sync/media`, so the same
  screenshot is stored once. The desktop polls every 15 seconds and immediately
  after sign-in, window focus, a finished turn or a coding-agent note. Settings
  has the account switch, a small status line and a manual nudge for support.
- **Code.** Every project is a real git repository whose remote is Hook's
  service (`/api/git/<project id>.git`). Coding agents pull before they start
  and push when they finish, so a project started on one computer arrives on
  the next one. The same policy gates it: a free account, or a paid one with
  sync off, keeps its projects local — no remote, no git token, and no
  `sync_pull` / `sync_push` tools in the agent. The account stores one bare repository per project; a pre-receive
  hook rejects pushes that would take a project over 200 MB or an account over
  1 GB, and a single push is capped at 100 MB.

- **Memory.** One row per entry over `/api/sync/memory`, folded into the same
  `/api/sync/changes` cursor as chats and projects. Last write wins on the
  device's clock, and a forgotten memory is a tombstone, so a deletion on one
  computer does not come back from another. It is not one document per account
  on purpose: two devices editing different memories merge instead of
  overwriting each other.
- **The live relay.** `/api/relay` is a WebSocket, not a store: presence, remote
  commands and the live copy of a turn on another machine. It is gated by the
  same paid + sync-on rule, so a free account or a switched-off account cannot
  reach another device through it. A missed frame costs nothing; the viewer
  reloads the chat through the normal sync path.

Project identities belong to the account, not to an installation. Because both
Hook and Hook Workspace open the same projects folder on a machine, two windows
can see the same folder under two different local ids; the account's id wins. A
folder bound to an account project keeps its id and its place, and a duplicate
name coming back from the server makes the local copy adopt the account's id
rather than create a second folder. A folder the account cannot accept — a name
over 64 characters, or one Windows reserves — stays on that machine and is
skipped by itself, so one impossible name cannot stop the rest of the account
from syncing.

On Windows, Hook runs the Git commands for startup and background project sync
without opening terminal windows.

Quotas: 250 MB of conversation JSON, 250 MB of chat pictures, 5,000 chats,
200 projects and 1,000 memories per account. Limits are server constants in `server/sync.mjs` and
`server/git.mjs`. Deleting the local folder only resets the device; sign-out
leaves the account's data in place. `DELETE /api/sync/account` (app token)
removes the account's chats, pictures, memories and repositories, and it keeps
working for an account that has gone free or turned sync off.

The policy itself is `syncRefusal()` in `server/plans.mjs`, applied by a gate on
every sync route except the account deletion, and mirrored client-side by
`policy_for()` in `sync.rs` — which also polls `/api/auth/me` every minute so a
plan change or a switch flipped in another product arrives without a restart.

Signing a different account in on the same machine moves the previous account's
conversations to `accounts\<id>\` instead of uploading them anywhere. Project
folders are the user's own files and stay where they are.

An AI report (see **Reporting AI output**) is the one deliberate exception to
"sync everything": it contains what the user chose to send, never the whole
account.

## Importing from ChatGPT or Claude

Settings → **Import history** turns the ZIP that ChatGPT or Claude produce from
their own "export my data" setting into ordinary chats.

- **The file is the user's own copy.** Nothing signs in to either service and no
  request leaves the machine: `import.rs` reads the archive, flattens each
  conversation onto the branch the user actually saw and writes chats through
  `store.rs`. Both vendors' terms forbid automated extraction from their chat
  products, and both provide the export — this is the one route that needs
  neither a private endpoint nor a scraper.
- **Formats.** ChatGPT ships `conversations.json` (split across numbered files on
  large accounts) as a `mapping` tree marked with `current_node`; editing a prompt
  leaves abandoned siblings behind, so the reader walks the parent chain from
  `current_node` and drops the rest. Claude ships a flat `chat_messages` list
  whose visible branch is the parent chain of the newest leaf. Entries are probed
  by shape rather than by name, so numbered splits, `user.json` and Claude's
  `projects.json` are all handled. Accepted input: the ZIP, the extracted
  `conversations.json`, or the unzipped folder.
- **Ids are derived, never random.** A chat's id is `cgpt_<conversation id>` or
  `cld_<conversation id>`, and message ids come from the source's own message
  ids. That is what makes a second import an update instead of a duplicate — on
  this machine and on every other one signed in to the account.
- **Re-import.** `ChatMeta.sourceUpdatedAt` records the source's `updated_at` at
  the last import. While it still equals the chat's own `updatedAt` nobody has
  touched the conversation here, so a newer export replaces the contents. As soon
  as the user replies or renames it, the local version wins and that chat is
  reported as "kept as yours".
- **Not imported.** Pictures and files (ChatGPT points at `asset_pointer`s whose
  files are usually missing from the archive; Claude's export documents that
  uploads are excluded), regenerated branches, projects, memories and custom
  instructions. Transcripts arrive as text.
- **Sync.** Imported chats are marked dirty and pushed like any other, ten per
  batch, so a big import keeps uploading in the background. The account's 5,000
  chat and 250 MB conversation limits still apply.

## Memory

The chat agent remembers things across conversations. Memory is **account**
data, not product data: it lives in `%APPDATA%\app.hook\memory\`, one file per
account, so the chat inside Hook Workspace knows what the chat inside Hook knows
and a different account on the same machine reads a different file.

Two shapes, on purpose:

- **Pinned** entries are in the prompt of every conversation. They are the
  things that should always be known: how the user likes to be talked to, what
  they work in, a correction that must not be repeated.
- **Everything else** is found with `memory_search` when it could change the
  answer. Nothing is retrieved automatically — see the cache note below.

All of it is editable in Settings → **Memory**: add, edit, pin, unpin, forget
one, forget everything, or switch memory off. Each row shows the kind, the age
and (from the store) the conversation it came from.

### What writes a memory

Only the turn that is already running. There is no extraction pass and no second
request: `remember`, `forget` and `memory_search` are ordinary tool calls, so
saving something costs a few tokens on a turn that was happening anyway. An
account with no extra spend is the whole reason memory is a tool and not a
background job — Hook has one model and the user pays for it.

Both writes are refused on a turn woken by a coding-agent note. A note can quote
a coding agent, and a coding agent can quote a web page; only the user's own
words become a fact about them. That is the memory-poisoning boundary, and it is
enforced in `run_tool` rather than asked for politely in the prompt.

`remember` pins `user` and `feedback` facts by default, which is what makes
"always know this" work without a second decision. `project` and `reference`
facts stay unpinned: they are found by search, so they do not tax every request.
The pinned set is capped (`max_pinned`, 40) and the block has a character budget
(`pinned_budget_chars`, 2400 ≈ 600 tokens). When it is full the tool refuses and
hands the pinned list back, so the agent merges instead of retrying.

### Why the prefix is append-only

Every provider Hook talks to caches a request by its longest common prefix with
an earlier one. Anything that rewrites the *beginning* of a request throws away
the whole cached conversation; appending keeps it.

Hook used to put the coding-agent notes, the live-agent hint and the window
context into the single leading system message. Every note that arrived
mid-conversation therefore invalidated the entire prefix — during coding
sessions, which are the expensive ones. Now:

- the leading system message is the instructions and nothing else, so it is
  byte-identical for the life of a chat;
- coding-agent notes and memory frames are ordinary hidden `system` messages,
  appended when they happen and **replayed in place** by `build_history`, so the
  sequence only ever grows;
- the live-agent hint and "what the user is looking at" are one trailing frame
  rebuilt per request, because changing the *last* thing costs nothing.

Memory follows the same rule, which is why it is told to a chat as frames rather
than injected per turn:

- The first turn of a chat appends **one** frame with everything pinned, at the
  top of the conversation.
- A later turn appends a frame with only what changed since the newest frame's
  revision — a memory added in this chat is already in the context, so normally
  there is nothing to append at all.
- A deletion cannot be appended as a fact, so it is appended as a correction
  ("no longer true"), and the later line wins by position.

`Message.kind` (`memory`) is what keeps a frame from being mistaken for a
coding-agent note when the prompt asks "is anything waiting?". The revision a
frame was written at is in its own first line (`[memory rev 12]`), so the
state travels with the conversation and syncs with it.

Two things follow, and both are load-bearing: nothing memory-shaped may be
re-retrieved per turn (that would rewrite the prefix), and the memory tools are
offered only when memory is on, so the prompt section and the toolset cannot
disagree.

There is exactly one deliberate exception: **compaction** (`compact.rs`). When a
conversation reaches its share of the window, the older turns are summarized into
one hidden `compaction` message parked where the cut happened, and every later
request starts from that summary. It is the only operation that drops the
prefix, which is why it happens rarely, once per crossing, and never mid-turn.

The trailing frame is sent as a `system` message: that is the right shape, and
every endpoint Hook has been pointed at accepts it. If one refuses, the turn is
retried with the same text as a `user` message and the refusal is remembered for
the rest of the session (`context_role_off` in `AppState`) — the same
self-healing that already exists for endpoints that reject image parts.
`[memory] context_role` sets it up front for a build that already knows.

### Project memory lives in the repository

`remember_in_project` writes a line into the project's own `AGENTS.md`, inside a
marked block:

```markdown
<!-- hook:memory Hook keeps these for coding agents; edits inside these markers are overwritten -->
- Use pnpm, not npm.
<!-- /hook:memory -->
```

`pi` already reads `AGENTS.md` from the folder it runs in, so the note reaches
every future coding agent with no new mechanism, and it travels with the code to
every computer through git. Only the block is Hook's: the rest of the file is
the user's and is left byte for byte alone. The block is capped at 40 lines,
oldest dropped. This is project knowledge ("how this repo is built and tested"),
not a fact about the person, so it is not in the account store.

### Recalling a conversation

`search_past_chats` runs the same search as the chat list over every stored
conversation on this machine and returns titles and snippets. It is the
"reference chat history" half of memory: no writes, no extra prompt, and the
agent uses it when the user refers to something from another chat. It is also
how an imported history becomes useful — ask the chat what it learned from the
import and it can search and remember the durable parts.

### Tests

`crates/hook-core/src/memory.rs` covers the store (accounts are isolated, a
repeated fact updates instead of piling up, the pinned budget holds, deltas list
only what changed, a synced entry reaches an open chat). `turn.rs` covers the
frame rules (told once, then only what changed; a frame is not a pending note;
the instructions never move). `projects.rs` covers the `AGENTS.md` block
(marked, merged, capped, never touching the user's own text). `server/sync.test.mjs`
covers the sync half (newest wins, tombstones, an unshaped entry is refused,
deleting the account clears memory).

## Advanced mode

Settings → **Advanced** turns on a debugging view of how answers are made. It is
off by default and belongs to the **account**, not to a machine or a product: a
phone should show what the computer shows, not its own idea of the view. The app
reads it from `/api/auth/me` and writes it through `POST /api/auth/preferences`
(`advancedMode`); a local `settings.json` value is what a signed-out or
local-preview build falls back to, and it is seeded to the account the first time
a window that already had the switch on signs in. It is a boolean, not content,
so a free account may set it — the paid-plan rule guards the cloud-sync switch,
not the display preference.

- **In a conversation**, a turn keeps the order it happened in: each message the
  model wrote, with one fold of thinking and tool calls between the messages.
  The newest fold stays open while the turn runs; when the turn ends it closes
  to one line (`Thinking · 2 tool calls`) and that line reopens it. Tool calls
  get a readable title and the argument that identifies the work (the command,
  the path, the query); expanding one shows the full arguments and the result.
  Nothing new is written for this: reasoning and tool calls were already in the
  chat file, and the history/prefix rules in **Memory → Why the prefix is
  append-only** are unchanged.
- **With Advanced off**, the conversation is the simple view: only the last
  message of each turn is drawn. Everything before it — earlier messages,
  thinking, tool calls — is hidden and belongs to Advanced. The prompt always
  says that the final message must contain the complete answer, so the same
  reply works in both views. The Workspace dock always has this view; the chat
  window and the phone can turn Advanced on. A direct coding chat keeps every
  message in the simple view, because its engine is not given that rule.
- **Automatic compaction is drawn as what it is.** A long conversation is
  summarized rather than replayed forever (see **Configure**, `[compact]`); the
  summary is a hidden message, so the simple view shows only the thinking line
  while it is written. With Advanced on, the cut is drawn where it happened: one
  line — *37 messages folded into a summary · 312k → 9k tokens* — that expands to
  the summary itself, at the point in the conversation it covers. A direct coding
  chat gets the same line from pi's own compaction (`/compact`, or the engine's
  automatic one), with the transcript itself untouched.
- **Commands.** With Advanced on, typing `/` in the composer opens a menu of
  commands; the same registry (`crates/hook-core/src/slash.rs`) decides what the
  backend accepts, so a hidden command cannot be typed in. The catalogue is
  returned by `slash_commands` and is empty unless Advanced is on. Today:
  `/compact [what to keep]` — compact now instead of waiting for the share — in
  both an ordinary conversation and a direct coding-agent chat. Adding a command
  is one entry in `COMMANDS` and one match arm in `slash::run`.
- **The sidebar** gains a **Coding agents** tree: one folder per project, with
  rows for runs that are still working, plus a run that stopped (stopped,
  failed, interrupted) in the open chat within the last few minutes. Older
  stopped runs and successful ones stay out of the tree; the one you are
  inspecting stays even if it finishes, until you switch chats. Clicking a row
  opens a read-only inspector with the same rendering — the brief, the agent's
  thinking, its narration, every tool call and result — and keeps polling while
  the run is live (`agent_transcript` reads the pi session file in
  `agent-sessions/` plus an in-memory tail for the message being streamed).
  There are deliberately no steering controls: steering, answering and stopping
  a run the chat agent started stay a conversation with the chat agent.
- **New chat gains a second way to start.** With Advanced on, the button has a
  menu with **Coding agent…**, which opens a conversation with the engine itself
  (see **Talking to a coding agent directly**). Turning Advanced off hides those
  conversations from the sidebar and closes one that is open; nothing is deleted,
  and they come back with the switch. On the phone the same rule hides the
  **Code on <machine>** chip on the home screen and the coding-agent rows in the
  archive. With Advanced off the chat agent is still the way to get work done on
  a machine: it has the same tools and starts the run from an ordinary
  conversation.

## Your machines

A paid account with cloud sync on can run coding work on any computer connected
to the same account. Hook is the host; Hook Workspace and HookCode are
controllers, so they can start, steer and stop work on a host but never run an
agent themselves.

- **The list.** **Settings → Your machines** shows every machine Hook has seen:
  its editable name, platform, app version, whether it is online, and whether it
  accepts remote work. A machine appears while Hook is running on it; turning
  the last switch off stops it accepting commands without removing it.
- **Starting work.** The chat agent calls `list_machines` and chooses: the
  machine the user named, the one this project ran on last, or the only one
  online. If none are on it says so and starts nothing; if several are possible
  it asks one short question with their names. Every agent tool takes the
  machine, even when there is only one, so the conversation records where each
  run happened.
- **Live.** A run on another machine publishes the same stream the local window
  draws: the answer, the plan, the status line. Close the laptop's window and
  the tray keeps Hook and its agents running; **Quit Hook** in the tray stops
  them. The phone can watch the same conversation and steer it.
- **Previews.** A preview served by a computer is opened through
  `<ticket>.preview.hookcode.io`, with the account service as the middleman. The
  machine dials out; nothing needs a forwarded port. The ticket is short-lived
  and only reaches the active preview for that conversation.
- **Requirements.** Remote control is part of a paid plan and requires cloud
  sync on. A free account can still use its own model endpoint for local agents;
  it cannot reach another machine.
- **Direct coding chats** (the user talking to `pi` themselves) can live on
  another machine too. The New chat menu offers **Coding agent on another
  machine…**; choose a host and one of its projects, create a new project
  there, or **Browse folders…** to start anywhere on that machine the local
  picker could reach (directories are listed one level at a time, never a
  file's contents). A folder picked that way is not registered as a project —
  it is the chat's folder, exactly as **Coding agent…** does on this computer.
  A folder's star in that picker pins it **on the host**: it is the same
  shortcut from every device of the account, and it is where the picker opens
  next time (Home, Projects and the drives follow it). Pins live in that
  machine's `settings.json`, so they are per-machine, at most twelve, and
  survive a restart.
  The host keeps the folder, the engine and the
  session. Only a small stub syncs — title, machine, live
  state, message count — never the transcript, a path or a session id. Opening
  the chat on another device fetches the conversation over the relay and caches
  it locally; that cache never uploads. If the host is offline, the cached copy
  opens instead. Steering, stopping and renaming still reach the host; changing
  the folder happens on the machine that owns it, because the folder and the
  engine only exist there. Deleting a cached chat also goes to the host — it
  removes the original there and queues the stub, which is why it needs that
  machine to be online — and then drops the copy here.

## Coding agents

The chat agent can create projects, brief a coding agent, and report back in the
conversation while you keep chatting.

A coding agent needs a paid plan, or a model endpoint of your own (see **Plans,
limits and your own model**). A free account without one gets a refusal from the
backend, no agent tools in the chat agent's toolset, and `coding_not_included`
from the proxy if a stale client tries anyway. With a personal endpoint the
engine is pointed at that endpoint and model instead of Hook's proxy.

- **Projects** live in one folder (default `~/Documents/Hook`), configured in the
  Settings sheet. Every chat can use every project. Each project carries a short
  description the chat agent maintains — that description is how it finds the
  right project later.
- **Instructions travel with the code.** `remember_in_project` writes a line
  into the project's `AGENTS.md` (in a marked block, see **Memory**), and `pi`
  reads that file every run. "Use pnpm, not npm" said once is then true for every
  coding agent in that repository, on every computer.
- **Projects are shared across computers** (on a paid account with sync on).
  Each project has an account id; the local folder name and path are per-machine. A project created here is a
  git repository with Hook's service as its `hook` remote, and an existing
  project gets one initial snapshot the first time it joins the account. On a
  second computer the folder is created and pulled automatically. Coding agents
  are told to call `sync_pull` before they start (the folder may be empty because
  the work began elsewhere) and `sync_push` when they finish, are blocked or
  stop early. The guard blocks force-pushes, branch deletion and mirroring, so a
  shared project cannot lose another computer's history.
- **Git ships with Hook.** `scripts/fetch-git.mjs` installs a pinned MinGit into
  `src-tauri/resources/git` (per app, next to the engine) like the coding engine (its GPL `LICENSE.txt` ships
  with it). Agents get it on `PATH` and a managed `gitconfig` in `agent-home`;
  the account's git token is scoped to `/api/git/*` and cannot read chats or
  spend model credits. The token lives in that config, never in a project or a
  remote URL.
- **The chat agent never touches files.** Its tools are `list_projects`,
  `create_project`, `update_project_description`, `start_coding_agent`,
  `list_agents`, `agent_status`, `steer_agent`, `answer_agent`, `stop_agent`
  and `list_coding_sessions`. All code reading and editing happens inside a
  coding agent, including setting the preview panel.
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
  `models.json` is written atomically from `harness.config.toml` before launch.
  The model credential is referenced as `$HOOK_PROVIDER_TOKEN` and supplied
  through the agent's environment — the account token for Hook's proxy, the
  user's own key for a personal endpoint. `$HOOK_API_TOKEN` stays the account
  token because the guard's web search needs it. The run id and chat id travel as
  `$HOOK_AGENT_ID` / `$HOOK_CHAT_ID` headers, so concurrent agents report usage
  against the right conversation; a personal endpoint gets none of them. An agent uses exactly the chat agent's endpoint and model and
  never touches your own `~/.pi` — different extensions, skills, MCP servers and
  logins on your machine cannot change what it does. Its thinking level is its
  own: with `[coding] thinking` empty the engine uses its default (medium)
  rather than the chat model's level, because a run is dozens of small turns and
  a high level on each one leaves the checklist frozen for minutes at a time.
- **The plan is visible, and so is the Stop button.** `start_coding_agent` takes
  a `plan`: three to six short steps in plain language (`Setting things up`,
  `Designing the front page`, `Hooking up the real service`), written by the
  chat agent, never file names or jargon. That checklist sits directly above
  the composer with the run's title: the active step shows a spinner, finished
  steps are struck through and settle to the bottom of the list, and only the
  step in progress carries a clock: it ticks while the agent works on it, and
  the time disappears once the step is crossed off. The coding agent
  keeps it current through `update_plan`, and a clean finish crosses off
  whatever is left. It cannot quietly batch the steps to the end: after a few
  tool calls without a checklist update a reminder rides on the tool result,
  and after more the next tool call is refused until the plan moves — so a
  long run's step actually changes while the work does. While an agent is
  live, the composer says **Steer the agent…**: your message is still answered
  by the chat agent, which passes the instruction on with `steer_agent`
  instead of starting a second agent. **Stop**
  kills every live agent in that chat — abort first, then the process tree —
  without a model round-trip. A finished checklist stays for a few minutes, then
  gets out of the way.
- **Progress updates — only when there is news.** Agents get one extra tool,
  `report_progress(note, images?)` and are told to use it for milestones,
  decisions, problems and the final result, never as a heartbeat: "still
  working" is explicitly off-limits, and long silences are expected. Notes go
  into a mailbox Hook watches; Hook batches them (at most one batch a minute,
  immediately on finish/fail/question) and hands the chat agent a note. The chat
  agent may answer `no_update`, which drops the message entirely — a batch that
  says nothing worth reading produces nothing in the chat. A quiet job can go
  from start to finish with a single update, or none until the result.
  A settle that follows an update the chat agent already spoke about is not
  news either: that wake carries only `new_since_last_update: none` and no
  copy of the run's final report, so the chat agent cannot repeat itself. A
  settle from a run nobody ever heard about is always reported. Pictures
  travel with the message the chat agent writes, so an update reads like "here
  is the menu as it stands" with the screenshot right there. How an agent
  produces them is up to it: a headless browser, the project's own harness, an
  engine's screenshot API.
- **A live preview when there is something to see.** The coding agent gets a
  `show_preview(file, title)` tool: it puts one HTML page from its project in a
  panel on the right. Hook serves the project over a loopback HTTP server, so
  relative CSS, images, modules and `fetch` behave like a normal browser, and
  the frame reloads whenever a web asset in the project changes. The page does
  not have to exist yet: the panel waits and loads it the moment the agent
  writes it. A small “Live preview” badge explains that the page is still in
  progress: it can change or reload on its own while the agent works. Previewing
  is optional and for the user's eyes — a frontend task, a data analysis with
  charts, a visual report. The guard tells the agent to set it early, and the
  chat agent asks for it in the brief. The first time a run shows a preview the
  panel opens; the user can hide it and bring it back from the title bar.
  Calling `show_preview` again switches the page. Hook watches only that one
  project. When the coding-agent run settles, the panel stays open and the page
  stays available: only the automatic refreshing stops, and the badge goes
  away, so the user can reload by hand. A deleted chat or quitting Hook stops it
  and closes the panel.
- **Context and output budget.** `[coding] context_window` (1,048,576) and
  `max_output_tokens` (393,216) are what `models.json` advertises to pi; both
  should match the model (check `GET /models`: `context_window` and
  `max_output_tokens`). The provider rejects a larger `max_tokens` outright, so
  this is the one ceiling to keep honest. pi clamps the output number to
  whatever room is left in the window (`window - prompt - 4096`). Lower it to
  cap cost: a tight cap is what makes a thinking model burn the budget on
  reasoning and stop with nothing written. The chat agent's own
  `[model] max_tokens` is separate.
- **Pictures from you.** Paste, drag or pick an image in the composer. Bytes are
  downscaled and stored on disk, not in the chat JSON.
- **Vision is a capability, not a setting.** At startup Hook asks the provider
  what the model does (`GET /models`, right next to the chat endpoint) and reads
  `input_modalities`, OpenRouter's `architecture`, or a `vision` flag. If the
  card says images, pictures reach the model as image parts and the engine is
  told the same before any agent starts; if it does not, or the provider has no
  model list, your pictures stay visible to you and are described in text. A
  card that promises more than the endpoint delivers costs that turn one retry
  without pictures, and Hook stops trying.
- **Image budget.** `[provider] max_images` (3) caps how many pictures reach the
  model in one request. The newest ones win: a fourth screenshot pushes out the
  oldest, which stays visible in the chat but is sent as
  `[older image omitted: 1280x800 png]` instead of pixels. A message can carry
  several pictures, so the budget is applied per attachment, not per message.
- **Looking at a picture.** Click any attachment — yours or an agent's
  screenshot — to open it large. From there: **Open** hands the file to your own
  image viewer (staged in `%TEMP%\hook-images`), **Save as…** writes a copy
  wherever you choose through the native dialog, **Full screen** (or a double
  click) fills the window. Esc closes, ← → step through the pictures in a
  message. Full-page captures scroll at readable width instead of shrinking to a
  sliver.
- **The guard is the only policy they inherit.** Every `bash` call must carry a
  `timeout` in seconds (1–3600 by default). Missing, oversized or non-numeric
  timeouts are blocked with an explanation, and the model re-issues the call.
  Tune it with `bash_max_timeout` / `bash_min_timeout`. The same guard offers
  `report_progress`, `update_plan`, `show_preview` and `web_search`, and seeds the coding
  agent with the checklist the user is watching so the wording stays plain. The
  checklist is also enforced: every third tool call without an `update_plan`
  carries a one-line reminder, and after five the next call is blocked with the
  current checklist. Both counters reset, so a run that keeps ignoring it can never hang.
- **They run asynchronously.** `start_coding_agent` returns immediately and you
  can keep talking. When an agent settles, fails, or asks a question, Hook
  appends a hidden note to the owning chat and wakes the chat agent, which posts
  an update in its own words. If the chat agent is mid-turn, the wake waits.
- **You see the work, not the machinery.** A title-bar pill says an agent is
  working (or waiting for an answer), the chat's task board shows the plan and
  how long the current step has been running, and every chat with a live agent
  gets a green dot in the sidebar.
  There is no log, no tool feed and no session browser: the raw run stays
  between Hook and the chat agent, and everything you read in the conversation
  is written by the chat agent.
- **Sessions are resumable.** They live in
  `%APPDATA%\app.hook.chat\agent-sessions\`. A finished agent — or one that
  was cut off when Hook closed — can be continued by session id.

Agents are children of Hook: closing the window kills their process trees and
marks the run `interrupted`, so nothing keeps running behind your back.

### Talking to a coding agent directly

The chat agent is not the only way to start a coding agent. With **Advanced**
on — and on a paid plan, or with your own model endpoint — the sidebar's **New
chat** button has a menu with **Coding agent…**: it asks for a folder and opens a
conversation with `pi` in it. There is no chat agent in
that conversation — what the engine says is what you read.

- **It is a chat, not a task-board entry.** The conversation sits in the normal
  list, marked with a terminal, and draws its thinking, tool calls, status line,
  plan and preview with the same components a chat turn uses. It does *not*
  appear in the **Coding agents** tree, which stays a list of runs the chat
  agent started.
- **Any folder.** The picker accepts any folder on disk. One inside the projects
  folder keeps its account repository and the `sync_pull` / `sync_push` tools;
  any other folder is used as it is, and the guard is told not to advertise git
  tools that have no repository. `ChatMeta.projectPath` holds the path, and
  **Change folder…** in the chat's menu points it somewhere else (which starts a
  fresh engine session, since the old session belonged to the old folder).
- **The chat agent's own tools come along.** On top of its file, shell,
  `web_search`, `update_plan` and `show_preview` tools, a direct agent gets what
  the chat agent can do with Hook's data: `list_projects`, `create_project`,
  `update_project_description`, `remember_in_project`, `remember` /
  `memory_search` / `forget` and the `workspace_*` family. The pinned memory the
  chat agent gets is in its prompt too. Two things are left out on purpose:
  `report_progress` (nobody relays it — the answer itself is the update) and
  every tool that starts, inspects or steers another coding agent (there are no
  subagents in this direction).
- **How those tools reach it.** The guard cannot call Rust, so `bridge.rs`
  listens on loopback and the guard `fetch`es it with a token minted for that
  chat. The schemas are written into the agent's mailbox (`tools.json`) from the
  same `definitions()` the chat agent uses, so the two surfaces cannot drift, and
  the endpoint only runs the tools that were advertised for that token.
- **You steer it yourself.** While it works, Send hands your message to the
  running agent and Stop kills it; a question it is blocked on appears in the
  task board with its options. A settled run stays warm for five minutes, and a
  later message resumes the same session (`ChatMeta.sessionId`), even after a
  restart. `/compact` asks the engine to fold its older turns into a summary
  (pi's own `compact` RPC); the chat's messages stay on screen, and the fold is
  drawn in advanced mode like any other.
- **Local only.** A coding-agent chat is never uploaded: the folder, the engine
  process and the session file exist on one computer, and half of that arriving
  on another would be worse than not arriving at all. Turning **Advanced** off
  hides these conversations from the sidebar and closes one that is open back to
  the empty pane (nothing is deleted; the chat returns with the switch, because
  the simple view cannot draw a run's tool-by-tool turns). Hook Workspace's dock
  never lists them.

The Settings sheet (gear in the sidebar footer) holds the account, Import
history, **Advanced** mode, Memory, Sync, the projects folder and updates.
Provider and model settings — and everything about the coding engine — stay
compiled into the build.

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
crates/hook-core/src/          the backend every product links
  config.rs     include_str! the TOML, expose typed config
  provider.rs   OpenAI-compatible SSE client + streamed tool_calls
  store.rs      atomic JSON persistence, pin/delete/restore/search
  turn.rs       the assistant turn: model → tools → tools → answer, plus wakes
  compact.rs    folding a long conversation into a summary
  slash.rs      the composer's commands (a registry, the parser, the runner)
  tools.rs      the tool schemas and their implementations
  agent.rs      engine RPC supervisor: spawn, states, plans, progress batching,
                wakes, stop-chat, read-only session transcripts
  coding.rs     a chat the user has with one coding agent directly: pi records →
                chat messages, steer/stop/answer, local-only sessions
  bridge.rs     loopback endpoint that runs the chat agent's own tools for a
                directly-driven agent (token per chat, advertised names only)
  runtime.rs    locate the bundled engine, write its models.json
  guard.rs      the guard extension, materialized from the binary
  update.rs     release index, update policy, checksum-checked installer
  settings.rs   projects folder, memory switch, advanced-mode fallback, the
                personal endpoint and its change stamp
  projects.rs   folder scanning, stable account ids, descriptions, containment
  git.rs        bundled git, managed config, repository preparation
  sync.rs       background chat/picture/project/memory/endpoint sync, server-side
                merge cursor
  auth.rs       device flow and the account file shared by every product
  commands.rs   the IPC surface
  lib.rs        Product + Capabilities, the app builder every product calls
apps/chat/                     the chat product
  src/lib/bridge.ts  typed invoke wrappers + app-wide event bus
  src/store/         zustand: chats, per-chat streams, agents, settings
  src/components/    Sidebar, Thread, Composer, AgentBoard, AgentTree,
                     AgentInspector, SettingsSheet…
  src/styles/        this product's layout (the foundation lives in packages/ui)
apps/workspace/                Hook Workspace
apps/mobile/                   HookCode on a phone (no agents, no folder)
  src/components/    ChatList, Conversation, PreviewSheet, SettingsSheet
  src/mobile.css     the phone's re-skin of the shared thread and composer
packages/ui/                   tokens.css, window chrome, primitives, the mark
packages/chat/                 Thread, Composer, ChatDock, Markdown…
  src/preview/       a board, a task and a document, drawn from preview JSON
```

The account service holds two more modules that every desktop product talks
to:
`server/git.mjs` (smart HTTP over `git http-backend`, one bare repo per project,
the `git-policy.mjs` size hook) and `server/sync.mjs` (cursor, chat merge,
project metadata, content-addressed media). Both are mounted under `/api`; git
is mounted before any JSON parser because pushes are binary streams.
`server/provider.mjs` is the third: the account's personal model endpoint, kept
apart from `/sync` because its key needs its own rule (AES-256-GCM at rest,
metadata and secret on separate routes).

Details worth knowing:

- **The renderer never sees the key.** All network calls happen in Rust.
- **Two kinds of conversation.** A chat is either a model turn (`turn.rs`) or the
  engine itself (`coding.rs`); `ChatMeta.kind` says which. Both write the same
  `Message` list, which is why the thread, the work blocks, the task board and
  the preview do not care — and why `packages/chat` never learns that `pi`
  exists. A `coding` chat is local-only and hidden while Advanced is off.
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
cargo test                                      # the whole workspace: no engine, no network
cargo test -p hook-core -- --ignored             # live tests against `pnpm mock`
pnpm typecheck                                  # the only static gate: every package + the site
pnpm waitlist:test                              # API, auth, proxy, download, sync, git, devices, relay, preview, workspace
pnpm test:release                               # "is this tree already published?"
pnpm test:markdown                              # the document dialect: parser, live editor, renderer, reference
pnpm test:licenses                              # every dep still fits AGPL-3.0-only
pnpm release                                    # build + publish the installers
```

GitHub Actions runs the checks on every push to `main` that can change a desktop
product, and on every pull request (`.github/workflows/checks.yml`): a `verify`
job (landing-page tests and build, the release-gate tests, `pnpm typecheck`, both
window builds) and a `rust-test` job (`cargo test -p hook-core`), in parallel.
Nothing there builds an installer — `pnpm release` does that, locally, when you
decide to ship (see **Releasing**). The release profile is `lto = "thin"` with
parallel codegen units, and a product ships one `rlib` plus its binary — not the
mobile `staticlib`/`cdylib` as well. `cargo test` covers SSE framing, UTF-8 splits, reasoning echo (the exact request
shapes thinking-mode APIs reject), image parts and the base64/header helpers,
path containment, the project and agent stores, progress batching, the chat-agent
tool loop, the guard policy (a Node harness feeds it bad `bash` calls, force-push
commands and the checklist/sync tools), the sync engine against a local HTTP
server (push+merge, pull+announce), a second machine's git clone/push, the git
size hook, the RPC handshake (spawns the real engine, asks `get_state`, never
calls a model) and a full agent lifecycle against a fake one that speaks the
protocol, the update policy (version ordering, the minimum floor, and a
manifest whose floor is ahead of its newest build), and the two export readers
(ChatGPT's `mapping` tree and Claude's parent chain, citations, hidden messages,
RFC 3339 dates, and a re-import that updates, skips or keeps a locally edited
chat). Tests skip themselves when the engine or `node` is missing.

The workspace suite (`server/workspace.test.mjs`) drives the real router against a
temporary SQLite file: the role table, an invitation accepted in the product,
viewer/editor/manager limits, ownership transfer and its permanence, a removed
member's tombstone in the changes feed, flexible property types (select,
multi-select, checkbox, timeline and hidden properties) and a board's default
view, several assignees on one task, comment editing and deletion by author or
manager, an agent comment
that carries the conversation it came from, a stale document write that is refused
with the current copy, folder nesting and deletion that keeps its contents, and
account deletion that removes owned projects but not other people's.
`server/relay.test.mjs` drives two real WebSocket clients against the hub:
presence, host/controller roles, RPC routing and timeout, per-chat fan-out,
removal and the paid gate. `server/preview.test.mjs` mints a ticket, tunnels a
request over the host's socket and checks the response. `server/releases.test.mjs`
covers the second product's index and its "not published yet" answer.

## A note on packaged builds

Two things only break in an installed app, never in `tauri dev`:

- Tauri hands out resource paths with the Windows `\?\` prefix. Node cannot load
  a script through one, so `runtime.rs` strips it before spawning (`strip_verbatim`).
- Resources are mapped with a directory rule (`"resources/pi-runtime": "pi-runtime"`).
  A `**/*` glob flattens the tree and the engine loses `pi/dist/bundle/cli.js`.

Both are covered by tests, and the portable zip is verified with
`src-tauri/resources/pi-runtime` moved aside so the dev copy cannot mask a
packaging bug. Agents write their stderr to `%APPDATA%\app.hook.chat\logs\`
(`%APPDATA%\hook-dev\app.hook.chat\logs\` for a debug build).

## License

Hook is licensed under the **GNU Affero General Public License, version 3.0**
(`AGPL-3.0-only`) — see [LICENSE](LICENSE). Copyright (C) 2026 Ben Timor; the
notice is in [NOTICE](NOTICE).

In short: you may use, study, modify, self-host and redistribute Hook, for
personal or commercial purposes, without paying anything. If you run a
**modified** version and let other people use it over a network, section 13
requires you to offer them the source of your modified version. That is the
whole difference from the GPL: a hosted fork cannot be kept closed.

The AGPL does not restrict the copyright holder. The Hook project's own builds,
the hosted service at `hookcode.io` and any commercial license are granted
separately, which is what makes the dual-licensing model possible.

Three things sit outside the code license:

- **The name and the mark.** The AGPL grants no rights to the names Hook, Hook
  Workspace or HookCode, to the logo, or to `hookcode.io`. A fork must rebrand —
  see [TRADEMARK.md](TRADEMARK.md). This is what actually makes resale
  unattractive, and it is deliberately separate from the license.
- **Bundled third-party software.** MinGit (GPL-2.0-only), Node (MIT) and the pi
  coding agent (MIT) ship inside an installer as separate programs. Their
  licenses are their own — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Contributions.** A signed CLA is needed before a non-trivial pull request
  can be merged, because dual licensing requires the project to hold sufficient
  rights over every contribution. You keep the copyright to your own work — see
  [CLA.md](CLA.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

If you need Hook under terms the AGPL cannot give you — using it inside an
organisation that bans network-copyleft, or embedding it in a closed product —
a commercial license is available. Write to **support@hookcode.io**.
