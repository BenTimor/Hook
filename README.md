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
./scripts/deploy-waitlist.sh     # build → upload site + source → rebuild container → probe
```

#### Automatic deploys (GitHub Actions)

Pushes to `main` deploy automatically. `.github/workflows/deploy-waitlist.yml` runs
`pnpm waitlist:test` + `pnpm waitlist:build` on a clean runner, then calls the same
`scripts/deploy-waitlist.sh` over SSH with `SKIP_BUILD=1` (it reuses the artifact the
verify job built). Pull requests run the checks without deploying
(`.github/workflows/ci.yml`). Deploys are serialized; a running deploy is never
cancelled by the next push.

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
`--revoke` sets the account back to `revoked`, invalidates its API tokens, and
the proxy refuses its next request. Approval does not resurrect a token that was
already revoked by signing out; the user signs in again. `--delete` removes the
waitlist row, tokens, device-login attempts, onboarding events and usage
metadata. The app checks the account on launch and whenever the proxy answers
`401`/`403`, so a revoked session drops back to the login screen instead of
failing silently.

An approved account sees a **Download Hook** button instead of the waiting-list
flow. The button points at `/api/download/windows`, which re-checks the session
and streams `DOWNLOAD_DIR/Hook-setup.exe`. The file and `latest.json` are written
by the release workflow described below. Nothing is served from GitHub, so a
shared link cannot bypass the approval check.

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

### Model proxy and usage

`/api/v1/chat/completions` is OpenAI-compatible, so the chat agent and pi use it
unchanged. The app does not send a provider or a meaningful model: the proxy
injects `DEEPSEEK_MODEL`, the server key and `stream_options.include_usage`, then
relays the SSE stream byte-for-byte. `/api/v1/models` describes the single
`HOOK_MODEL_ID` model (with the configured model's context, output and image
capabilities) so the app's capability probe works.

A reply that never starts, or starts and then goes quiet, is an error rather
than an endless spinner: the request gives up after two minutes without an
answer, and the stream fails after two minutes without a chunk, so a dead
connection says "The model stopped sending data" and can be retried.

Every request is tagged with headers from the client:

| Header | Meaning |
|---|---|
| `X-Hook-Surface` | `chat` or `coding` |
| `X-Hook-Chat-Id` | Conversation id, so usage can be grouped per chat |
| `X-Hook-Agent-Id` | Coding-agent run id, set per spawned process |
| `X-Hook-Client` / `X-Hook-App-Version` | Client build |

`usage_events` stores input/output tokens, `prompt_cache_hit_tokens`,
`prompt_cache_miss_tokens`, reasoning tokens, duration, time-to-first-token and
the status for each request. The cache hit rate is computed from the hit/miss
pair, not from a guess. Analyse it with:

```bash
./scripts/waitlist-admin.sh --usage          # per account
./scripts/waitlist-admin.sh --usage-chats    # per conversation
./scripts/waitlist-admin.sh --usage-agents   # per coding-agent run
```

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

### Automatic Windows builds

`.github/workflows/release-app.yml` runs on every push to `main` that can change
the desktop app. A cheap first job fingerprints the application source
(`scripts/app-source-hash.mjs`) and compares it with the published release, so a
twenty-minute Windows build only happens when there is something new to ship:

| Repo state | What happens |
|---|---|
| Same application source as the published build | the build is skipped |
| Source changed, version bumped | builds and publishes |
| Source changed, same version | fails and asks for `pnpm version:bump` |
| Source changed, lower version | fails (no downgrades) |

The build runs on `windows-latest` (roughly 15 minutes), writes
`release/latest.json` (version, commit, builtAt, size, SHA-256, source hash,
release notes), merges it into `release/releases.json`, and uploads the installer
(under `Hook-<version>-setup.exe`) and the index to `/opt/hook-web/data/releases`
over the same SSH deploy key as the website. Builds also appear as workflow
artifacts for 14 days.

Publishing never takes downloads down. The new installer is uploaded under its
versioned name first; the old `releases.json` keeps serving the previous version
until the new one is complete, and the index swap is a single `mv`. The last five
versions stay downloadable.

Bump the version with `pnpm version:bump patch` (or `minor`, `major`, or an
explicit version, add `--product workspace`). It updates that product's
`package.json`, `src-tauri/Cargo.toml`, the workspace `Cargo.lock` and
`src-tauri/tauri.conf.json` together: the app reports
Cargo's version, the installer is named after Tauri's, and the release manifest
refuses to publish if they disagree.


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
| Branding | app name `Hook`, support/contact `nsgi3111@gmail.com`, authorised domain `hookcode.io`, home `https://hookcode.io`, policy links to `/privacy` and `/terms` |

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
into the binary with `include_str!`, so there is no way to change it at runtime:

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
```

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
clone, copy `harness.config.ci.toml` (the build the release workflow ships) or
`harness.config.example.toml`. The production config requires a signed-in
approved account. For UI work without the service, use the mock provider below.
The config file must exist before building — it is compiled into the binary, so a
missing file is a compile error by design.

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
  ~54 MB (the release workflow copies it to `release/Hook-<version>-setup.exe`)
- `release/Hook-<version>-portable.zip` — `Hook.exe` + `resources\pi-runtime` +
  `resources\git`, no install

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
provider. The Windows release workflow copies the committed
`harness.config.ci.toml` (hookcode.io proxy, no secrets) into that slot before
building.

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
  "store": { "latest": "0.2.0", "minimumVersion": "0.1.0" }
}
```

`store.latest` stays empty until Microsoft certifies the named version; an empty
value means Store builds are never told an update exists. Raise
`store.minimumVersion` only to force Store installs below it to update.

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
`https://hookcode.io/api/releases`; the website's signed-in download uses the
same data, and `/api/download/windows?version=` pins an exact build.

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
5. Put the Store ID in `harness.config.ci.toml`:

   ```toml
   [update]
   store_id = "9N..."
   ```

The reserved product name is **HookCode**; the MSIX display name matches it, while
the app's own window and chat UI stay branded **Hook**. Until step 4,
`node scripts/build-msix.mjs` prints these instructions and exits without
packaging, so a direct release is never blocked by an unconfigured Store
identity.

### Build the package

```bash
pnpm app:msix      # fetch the engine, build Hook.exe, package the MSIX
```

The result is `release/Hook-<version>-x64.msix` (about 84 MB with the bundled
engine and git). The release
workflow runs the same packaging step after the NSIS build and keeps the `.msix`
in the `hook-windows-release` artifact for 14 days. The package is deliberately
unsigned: Partner Center re-signs Store submissions, and signing it yourself
with a self-signed certificate only breaks the upload. For local sideload
testing, pass `--sign dev.pfx --password …` to sign with a development
certificate.

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

**Short description** (256 characters max, currently 235):

> HookCode is the Microsoft Store edition of Hook, an AI chat app with coding
> agents for Windows. Hand real work to agents that edit and run projects, bring
> your ChatGPT or Claude history with you, and continue on any signed-in computer.

**Full description:**

> HookCode is the Microsoft Store edition of Hook, an AI chat app with coding
> agents for Windows.
>
> Chat with one model, then hand real work to coding agents that can read, edit
> and run projects in a folder you choose. Your conversations, pictures and
> project code are saved to your Hook account, so you can start on one computer
> and continue on another. The coding engine itself runs on your PC. An approved
> Hook account unlocks the model through Hook's relay.
>
> WHAT YOU CAN DO
>
> • Ask anything in a clean, focused chat.
> • Create projects and brief a coding agent in plain language.
> • Watch the agent's plan while it works, steer it mid-run, and stop it at any
>   time.
> • See a live preview of the page or report the agent is building.
> • Attach screenshots and images and ask questions about them when the model
>   supports vision.
> • Keep every conversation in readable files on your machine, with search,
>   pinning and undoable deletion — and an account copy that keeps your
>   computers in step.
> • Bring your ChatGPT or Claude history with you: import the export those
>   services already give you, and it becomes ordinary Hook conversations you
>   can search and continue. Re-importing picks up whatever is new without
>   duplicating anything.
> • Start a conversation or a project on one PC and pick it up on another,
>   without exporting or transferring anything.
> • Update HookCode from inside the app — the Store handles the download and
>   restart.
>
> YOUR WORK, ON EVERY COMPUTER
>
> Your chats, pictures and project code are saved to your Hook account so the
> same work is available on every computer you sign in to. The saved workspace
> is stored on hookcode.io. Deleting a conversation removes it from your account
> on the next sync; ask us to delete the whole workspace or your account and we
> will remove the chats, pictures and project repositories. Project repositories
> contain the files the coding agent saved, which can include configuration and
> `.env` files — do not put files in a project that you would not want stored
> with your account. Model requests are relayed through hookcode.io to our model
> provider; apart from the saved workspace, we do not store the text, pictures,
> tool definitions or replies — except when you deliberately send a report (see
> below). We store the metadata needed to run and measure the service (account
> identifier, token counts, cache statistics and request status). See the
> privacy policy for the full picture.
>
> LIVE GENERATIVE AI
>
> HookCode uses live generative AI. Every reply and every coding-agent step is
> produced by an AI model in response to what you type. AI output can be wrong,
> incomplete or inappropriate — check important results before relying on them.
> Use the Report action on any reply to send it to us for review; you can
> optionally include the whole conversation.
>
> BUILT FOR CODING
>
> Coding agents work inside a project folder with a bundled Node runtime, the pi
> coding agent and git. They can read and edit files, run commands with timeouts,
> search the web and show you a live preview. Each project is backed by a private
> git repository in your account: agents pull the latest saved work before they
> start — even when the project was begun on another computer — and save when
> they finish. They run as child processes of HookCode and stop when you close
> the app.
>
> REQUIREMENTS
>
> • Windows 10 version 2004 (build 19041) or later, or Windows 11.
> • Microsoft Edge WebView2 Runtime (preinstalled on Windows 11 and on Windows 10
>   with Edge).
> • An approved Hook account. HookCode is in early access: sign in with the
>   Google account that was approved for Hook. If you do not have access yet,
>   join the waitlist at https://hookcode.io.
> • An internet connection for model requests and for syncing your saved work.
>
> HookCode is free to download. Model access is included with an approved
> early-access account; there are no per-message charges.
>
> Support: https://hookcode.io
> Privacy: https://hookcode.io/privacy
> Terms: https://hookcode.io/terms

**Feature bullets** (optional; each under 200 characters):

> • Your work follows you: chats, pictures and projects are saved to your account and available on every computer.
> • Bring your ChatGPT or Claude history with you in one import, and re-import whenever you want.
> • Projects are backed by private git, so agents continue from the latest saved work.
> • Coding agents that read, edit and run real projects.
> • A live plan and progress while an agent works; steer or stop it at any time.
> • A live preview of the page or report being built.
> • One-click updates through the Microsoft Store.
> • Search, pin and undoably delete conversations.
> • Image attachments, with vision when the model supports it.
> • Report inappropriate AI output from inside the app.

**What's new in 0.2.1** (Partner Center "What's new in this version", 876 characters):

> HookCode 0.2.1 makes it easy to bring your history over, and fixes project
> saving.
>
> • Import your ChatGPT or Claude history: Settings › Import history, choose the
>   archive those services already give you, and the conversations appear as
>   normal chats — searchable, syncable and ready to continue.
> • Re-import whenever you have new conversations. What is already here is
>   updated in place instead of duplicated, and anything you have written in
>   Hook since keeps your version.
> • The import runs entirely on your PC. Nothing signs in to ChatGPT or Claude:
>   the file you downloaded is what gets read.
> • Settings now opens with Import history, followed by Sync.
> • Fixed: an account with more than ten projects could fail to save project
>   metadata. Projects now sync in batches, as chats already did.
> • Transcripts arrive as text. Pictures and files inside an export stay where
>   they are.

**Search terms:** AI chat, coding agent, AI assistant, code assistant, developer
tools, cross-device sync, project sync. ("ChatGPT import" is tempting but it is
someone else's trademark in a keyword field — leave it out unless you want to
argue about it.)

## Hook Workspace

The second product. A project holds boards of tasks, Markdown documents and the
people they are shared with; folders organize them, and can nest. It is its own installer
(`apps/workspace`, identifier `app.hook.workspace`) with the same window chrome,
the same account and the same chat beside it.

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

- **One cursor.** Every workspace row carries `seq` from one global counter;
  `GET /api/ws/changes?since=N` returns rows in projects the caller belongs to,
  tombstones included, bounded by rows and bytes. Clients keep the last `seq`.
- **Documents are Markdown.** The buffer is the document, so there is no
  round-trip to lose formatting. A write carries the revision it was based on;
  a stale one is refused with the current copy rather than silently overwriting
  someone else's paragraph.
- **Comments know how they were written.** `author_kind` is `user` or `agent`,
  and an agent comment carries the conversation it came from, so a teammate sees
  "via Hook agent" instead of mistaking it for something the user typed.
- **The chat agent can do everything a person can, except transfer ownership.**
  `workspace_projects`, `workspace_folders`, `workspace_boards`,
  `workspace_tasks`, `workspace_comments`, `workspace_documents`,
  `workspace_members`, `workspace_invites` and `workspace_preview` are ordinary
  chat tools (`crates/hook-core/src/workspace.rs`) that call the account API with
  the user's token, so the server checks the user's real role.
- **Previews.** `workspace_preview` puts a task, board or document in the preview
  panel. It is a second kind of preview next to the HTML page a coding agent can
  show, and the panel renders it directly instead of in an iframe.
- **Folders are rows, not a client feature.** A folder carries a name, an
  optional parent and a position; a board or a document carries a `folderId`.
  Deleting a folder is a tombstone like anything else, and whatever was inside
  it stays in the project at the top level — the tree is organization, never a
  container that can swallow work. Two people see the same tree because it is
  the project's, not theirs.
- **The window is online-first.** The server is the source of truth, so the app
  keeps an in-memory copy and applies `/api/ws/changes` every five seconds while
  visible (and on focus). Nothing on disk can drift from the account, and there
  is no merge to get wrong. Offline work is the next step, not a promise made
  here.
- **The chat sits beside the work.** A collapsible right-hand panel embeds the
  same conversations as Hook (`packages/chat`), collapsed by default with its
  conversation list collapsed as well. The thread, the messages and the composer
  are the ones the chat window renders — the dock only restyles them for a 380px
  column, so there is one chat surface to fix, not two. It has no preview panel; a preview is a
  wide, page-shaped thing, and the dock is deliberately narrow. The window tells
  the backend what it is showing — project, board, open task, selected text — and
  that rides on the next request as context, so "summarise this board" means the
  board on screen. The context is never stored in the chat.
- **Its own download slot.** `/api/releases/workspace` and
  `/api/download/windows?product=workspace` serve the Workspace installer; the
  chat app keeps its historical URLs. Installers are uploaded under versioned
  names and the index is swapped last, exactly like the chat app.

## One account, several products

Hook is a family of desktop products, and the account is the family's centre of
gravity:

- **One sign-in.** `%APPDATA%\app.hook\account.json` holds the session and this
  installation's device id. Any product reads it at launch, so installing the
  second one does not ask again. Signing out writes an empty session back, which
  signs out every product — it is an account decision, not a product one.
- **One device id per machine.** The server rotates a git token per
  `(account, device)` pair, so two products sharing an id look like one computer
  rather than two. Only the chat app mints git tokens; Workspace never does, so
  they cannot revoke each other.
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

## Where the data lives

```
%APPDATA%\app.hook\
  account.json             the signed-in account, shared by every Hook product
                           on this machine (signing in to one signs in all)

%APPDATA%\app.hook.chat\      Hook's own data
  chats\<id>.json          one readable JSON file per conversation
  trash\                   undoable deletions
  images\<chat id>\        pictures attached to messages (bytes on disk)
  settings.json            projects folder
  projects.json            the notes the chat agent keeps about projects
  agents.json              coding-agent runs and their states
  auth.json                a mirror of the shared account, so a downgrade works
  device.json              this installation's id (git tokens rotate per device)
  sync.json                the sync cursor, pending uploads and account owner
  accounts\<id>\           conversations moved aside when a different account
                           signs in on this machine (never uploaded)
  agent-sessions\          coding-engine session files (resumable)
  agent-home\              the engine's own config: models.json (endpoint,
                           model and `$HOOK_*` header references), gitconfig
                           (managed git identity and the scoped git token),
                           settings.json
  updates\<agent id>\      progress notes, checklist updates and preview pointers
                           the agents wrote, collected each second
  hook-guard.mjs           the guard loaded into every coding agent
```

Hook Workspace writes to `%APPDATA%\app.hook.workspace\` and reads the same
`%APPDATA%\app.hook\account.json`, so the two products never ask for a sign-in
twice; its cached data and the service it talks to are documented in
**Hook Workspace**.

The Microsoft Store (MSIX) build writes to the same `%APPDATA%\app.hook.chat`
folder: its manifest opts out of AppData virtualization so Store and direct
installs share chats and sign-in. In-app updates download installers to
`%TEMP%\hook-update\`; nothing else is written outside this folder.

## Sync between computers

A signed-in account keeps the whole workspace in step without a button. Two
independent mechanisms are at work:

- **Conversations.** Each device pushes changed chats to `/api/sync/chats` and
  pulls everything newer than its cursor from `/api/sync/changes`. The server is
  the only merger, so every machine converges on the same answer: messages are
  unioned by id (a finished copy beats a stale in-flight one), titles and pins
  follow the newer chat, a deletion is a tombstone, and an explicit restore
  revives it. A chat that is streaming is never uploaded or overwritten until its
  turn ends. Pictures travel by SHA-256 through `/api/sync/media`, so the same
  screenshot is stored once. The desktop polls every 15 seconds and immediately
  after sign-in, window focus, a finished turn or a coding-agent note; there is
  no sync button, though Settings has a small status line and a manual nudge for
  support.
- **Code.** Every project is a real git repository whose remote is Hook's
  service (`/api/git/<project id>.git`). Coding agents pull before they start
  and push when they finish, so a project started on one computer arrives on
  the next one. The account stores one bare repository per project; a pre-receive
  hook rejects pushes that would take a project over 200 MB or an account over
  1 GB.

Project identities belong to the account, not to an installation. Because both
Hook and Hook Workspace open the same projects folder on a machine, two windows
can see the same folder under two different local ids; the account's id wins. A
folder bound to an account project keeps its id and its place, and a duplicate
name coming back from the server makes the local copy adopt the account's id
rather than create a second folder. A folder the account cannot accept — a name
over 64 characters, or one Windows reserves — stays on that machine and is
skipped by itself, so one impossible name cannot stop the rest of the account
from syncing.

Quotas: 250 MB of conversation JSON, 250 MB of chat pictures, 5,000 chats and
200 projects per account. Limits are server constants in `server/sync.mjs` and
`server/git.mjs`. Deleting the local folder only resets the device; sign-out
leaves the account's data in place. `DELETE /api/sync/account` (app token)
removes the account's chats, pictures and repositories.

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

## Coding agents

The chat agent can create projects, brief a coding agent, and report back in the
conversation while you keep chatting.

- **Projects** live in one folder (default `~/Documents/Hook`), configured in the
  Settings sheet. Every chat can use every project. Each project carries a short
  description the chat agent maintains — that description is how it finds the
  right project later.
- **Projects are shared across computers.** Each project has an account id;
  the local folder name and path are per-machine. A project created here is a
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
  The token is referenced as `$HOOK_API_TOKEN` and supplied through the agent's
  environment; the run id and chat id travel as `$HOOK_AGENT_ID` /
  `$HOOK_CHAT_ID` headers, so concurrent agents report usage against the right
  conversation. An agent uses exactly the chat agent's endpoint and model and
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
crates/hook-core/src/          the backend every product links
  config.rs     include_str! the TOML, expose typed config
  provider.rs   OpenAI-compatible SSE client + streamed tool_calls
  store.rs      atomic JSON persistence, pin/delete/restore/search
  turn.rs       the assistant turn: model → tools → tools → answer, plus wakes
  tools.rs      the tool schemas and their implementations
  agent.rs      engine RPC supervisor: spawn, states, plans, progress batching,
                wakes, stop-chat
  runtime.rs    locate the bundled engine, write its models.json
  guard.rs      the guard extension, materialized from the binary
  update.rs     release index, update policy, checksum-checked installer
  settings.rs   projects folder
  projects.rs   folder scanning, stable account ids, descriptions, containment
  git.rs        bundled git, managed config, repository preparation
  sync.rs       background chat/picture/project sync, server-side merge cursor
  auth.rs       device flow and the account file shared by every product
  commands.rs   the IPC surface
  lib.rs        Product + Capabilities, the app builder both products call
apps/chat/                     the chat product
  src/lib/bridge.ts  typed invoke wrappers + app-wide event bus
  src/store/         zustand: chats, per-chat streams, agents, settings
  src/components/    Sidebar, Thread, Composer, AgentBoard, SettingsSheet…
  src/styles/        this product's layout (the foundation lives in packages/ui)
apps/workspace/                Hook Workspace
packages/ui/                   tokens.css, window chrome, primitives, the mark
```

The account service holds two more modules that every desktop product talks
to:
`server/git.mjs` (smart HTTP over `git http-backend`, one bare repo per project,
the `git-policy.mjs` size hook) and `server/sync.mjs` (cursor, chat merge,
project metadata, content-addressed media). Both are mounted under `/api`; git
is mounted before any JSON parser because pushes are binary streams.

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
cargo test                                      # the whole workspace: no engine, no network
cargo test -p hook-core -- --ignored             # live tests against `pnpm mock`
pnpm typecheck                                  # the only static gate: every package + the site
pnpm waitlist:test                              # API, auth, proxy, download, sync, git, workspace
pnpm test:release                               # "does this push need a Windows build?"
```

GitHub Actions runs on every pull request **and every push to `main`**: the
landing-page tests and build, then `pnpm typecheck`, both window builds and
`cargo test -p hook-core` on Windows (`ci.yml`). The release workflows run the
typecheck and the Rust tests again before they build an installer, so a failing
test cannot ship. `cargo test` covers SSE framing, UTF-8 splits, reasoning echo (the exact request
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
member's tombstone in the changes feed, typed task columns, an agent comment that
carries the conversation it came from, a stale document write that is refused
with the current copy, folder nesting and deletion that keeps its contents, and
account deletion that removes owned projects but not other people's. `server/releases.test.mjs` covers the second product's
index and its "not published yet" answer.

## A note on packaged builds

Two things only break in an installed app, never in `tauri dev`:

- Tauri hands out resource paths with the Windows `\?\` prefix. Node cannot load
  a script through one, so `runtime.rs` strips it before spawning (`strip_verbatim`).
- Resources are mapped with a directory rule (`"resources/pi-runtime": "pi-runtime"`).
  A `**/*` glob flattens the tree and the engine loses `pi/dist/bundle/cli.js`.

Both are covered by tests, and the portable zip is verified with
`src-tauri/resources/pi-runtime` moved aside so the dev copy cannot mask a
packaging bug. Agents write their stderr to `%APPDATA%\app.hook.chat\logs\`.
