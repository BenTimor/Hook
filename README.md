# Hook

A local AI chat app with an approved account gate. Tauri 2 (Rust) + React 19
+ TypeScript.

One model, one thinking level — baked in at build time. Sign in with the Google
account that was approved on the waiting list, and the same session unlocks the
chat window, the coding agents, and a model proxy that keeps the provider key
server-side. Conversations stay on your machine; the account service only sees
token counts and cache statistics.

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

Run `pnpm waitlist:test` for the API, device-login, proxy, usage and download
regression checks.

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

The token lives in `%APPDATA%\app.hook.chat\auth.json`. The chat agent sends it
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
explicit version). It updates `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json` together: the app reports
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
pnpm engine        # fetch the coding engine into src-tauri/resources/pi-runtime
pnpm app:build     # NSIS installer (runs `pnpm engine` first)
pnpm app:portable  # portable folder, zipped (runs `pnpm engine` first)
```

Outputs:

- `src-tauri/target/release/bundle/nsis/Hook_<version>_x64-setup.exe` — installer,
  ~28 MB (the release workflow copies it to `release/Hook-<version>-setup.exe`)
- `release/Hook-<version>-portable.zip` — `Hook.exe` + `resources\pi-runtime`, no install

The engine (Node + pi) is ~104 MB of binaries and is not in git; `pnpm engine`
copies it from the pinned `@earendil-works/pi-coding-agent` dev dependency.
`scripts/fetch-pi-runtime.mjs` also proves the copy can load Hook's guard before
anything gets packaged.

`pnpm version:bump patch|minor|major` is the only way to change the version (see
[Updates](#updates)); hand-editing one of the four files makes the app and the
installer disagree.

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

## Where the data lives

```
%APPDATA%\app.hook.chat\
  chats\<id>.json          one readable JSON file per conversation
  trash\                   undoable deletions
  images\<chat id>\        pictures attached to messages (bytes on disk)
  settings.json            projects folder
  projects.json            the notes the chat agent keeps about projects
  agents.json              coding-agent runs and their states
  auth.json                the opaque API token from the approved Google account
  agent-sessions\          coding-engine session files (resumable)
  agent-home\              the engine's own config: models.json (endpoint,
                           model and `$HOOK_*` header references), settings.json
  updates\<agent id>\      progress notes, checklist updates and preview pointers
                           the agents wrote, collected each second
  hook-guard.mjs           the guard loaded into every coding agent
```

In-app updates download installers to `%TEMP%\hook-update\`; nothing else is
written outside this folder.

The app keeps no local database and no sync. Conversations never leave the
machine; the account service sees the request metadata described above (token
counts, cache hits, a chat id and a coding-agent run id) and stores it next to the
account. Deleting the folder resets the local app; revoke the account on the
server to remove access.

## Coding agents

The chat agent can create projects, brief a coding agent, and report back in the
conversation while you keep chatting.

- **Projects** live in one folder (default `~/Documents/Hook`), configured in the
  Settings sheet. Every chat can use every project. Each project carries a short
  description the chat agent maintains — that description is how it finds the
  right project later.
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
src-tauri/src/
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
  projects.rs   folder scanning, descriptions, path containment
  commands.rs   the IPC surface
src/
  lib/bridge.ts  typed invoke wrappers + app-wide event bus
  store/         zustand: chats, per-chat streams, agents, settings
  components/    Sidebar, Thread, Composer, AgentBoard, SettingsSheet,
                 AgentPill…
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
cd src-tauri && cargo test                      # unit tests + two zero-cost integration checks
cd src-tauri && cargo test --lib -- --ignored   # live tests against `pnpm mock`
pnpm waitlist:test                              # API, device login, proxy, download, release index
pnpm test:release                               # "does this push need a Windows build?"
```

`cargo test` covers SSE framing, UTF-8 splits, reasoning echo (the exact request
shapes thinking-mode APIs reject), image parts and the base64/header helpers,
path containment, the project and agent stores, progress batching, the chat-agent
tool loop, the guard policy (a Node harness feeds it bad `bash` calls and the
checklist tool), the RPC handshake (spawns the real engine, asks `get_state`,
never calls a model) and a full agent lifecycle against a fake one that speaks
the protocol, and the update policy (version ordering, the minimum floor, and a
manifest whose floor is ahead of its newest build). Tests skip themselves when the
engine or `node` is missing.

## A note on packaged builds

Two things only break in an installed app, never in `tauri dev`:

- Tauri hands out resource paths with the Windows `\?\` prefix. Node cannot load
  a script through one, so `runtime.rs` strips it before spawning (`strip_verbatim`).
- Resources are mapped with a directory rule (`"resources/pi-runtime": "pi-runtime"`).
  A `**/*` glob flattens the tree and the engine loses `pi/dist/bundle/cli.js`.

Both are covered by tests, and the portable zip is verified with
`src-tauri/resources/pi-runtime` moved aside so the dev copy cannot mask a
packaging bug. Agents write their stderr to `%APPDATA%\app.hook.chat\logs\`.
