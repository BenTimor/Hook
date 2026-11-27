# infra/

Reference copies of the server-side configuration for the **Hook landing page**
(`hookcode.io`). Everything here is uploaded by `./scripts/deploy-waitlist.sh`
on every deploy — edit it *here*, not on the server. CI runs that script on a
`deploy-*` tag on the tip of `main` (`.github/workflows/deploy-waitlist.yml`), so
an ordinary push changes nothing here; run the script yourself for a manual
deploy.

| File | Lives on the server at | Purpose |
|------|------------------------|---------|
| `docker-compose.yml` | `/opt/hook-web/docker-compose.yml` | `hook-waitlist` container (built from `/opt/hook-web/app`), joins `scout_default`, SQLite bind-mounted from `/opt/hook-web/data` |
| `hookcode.caddy` | `/opt/hook-web/hookcode.caddy` | Caddy site block: serves `/opt/hook-web/site`, proxies `/api/*` (waitlist, device login, model proxy, private git, conversation sync, devices, relay, workspace, download, release index) to the container, `www` → apex redirect |
| `preview.caddy` | `/opt/hook-web/preview.caddy` | `*.preview.hookcode.io` → the same container, using the wildcard certificate below. Uploaded and reloaded by the deploy. |
| `hook-preview-cert.cron` | `/etc/cron.d/hook-preview-cert` | Renews that wildcard with certbot's Cloudflare DNS-01 plugin and reloads Caddy. |

`release.config.json` (repo root) is copied into the image by the Dockerfile. It
holds each product's floor: the chat app's `minimumVersion` (oldest build allowed
to keep working), its Microsoft Store channel's `store.productId`,
`store.latest` / `store.minimumVersion`, and the same block under
`products.workspace` for Hook Workspace. `store.productId` is the listing the
landing page's approved screen opens (`ms-windows-store://pdp/?productid=…`), so
the site never links an installer. Raising a floor forces older installs to
update on their next check, without rebuilding the app, and `store.latest` is set
only after a Store submission is certified. It is shipped by `deploy-waitlist.sh`
like any other tracked file.

## Release slots (one per product)

`DOWNLOAD_DIR` holds both products' installers side by side:

| File | Product | Public route |
|------|---------|--------------|
| `releases.json` | Hook (chat) | `GET /api/releases` |
| `Hook-<version>-setup.exe` | Hook (chat) | `GET /api/download/windows?version=…` |
| `releases.workspace.json` | Hook Workspace | `GET /api/releases/workspace` |
| `Hook-Workspace-<version>-setup.exe` | Hook Workspace | `GET /api/download/windows?product=workspace&version=…` |

Each workflow only deletes installers its own index mentions (`Hook-[0-9]*.exe`
versus `Hook-Workspace-*.exe`), so publishing one product cannot remove the
other's download. The indexes are swapped last, after the installer is in place.

## Release slot

`/opt/hook-web/data/releases` is bind-mounted into the container as
`/data/releases` (`DOWNLOAD_DIR`) and written only by the Windows release
workflow:

| Path | Purpose |
|------|---------|
| `releases.json` | the published index; swapped last, atomically |
| `Hook-<version>-setup.exe` | one immutable installer per version (last five kept) |
| `latest.json` | the newest build's manifest (version, commit, size, SHA-256) |
| `Hook-setup.exe` | legacy single-slot installer; read only while the index does not exist yet |

`GET /api/releases` is public and returns `{ latest, minimum, updatedAt, releases }`
for the desktop updater and anyone curious. `GET /api/download/windows?version=`
is still gated to signed-in, approved accounts. A bad `releases.json` never takes
downloads down: entries whose installer file is missing are ignored, and the old
index keeps serving the previous version until the swap.

## Private git and conversation sync

The desktop app stores every project in one bare repository on the same volume,
so a user can continue on another computer. Two more folders appear under
`/opt/hook-web/data` the first time a signed-in account syncs:

| Path | Container path | Purpose |
|------|----------------|---------|
| `data/git/<hashed account>/<project id>.git` | `/data/git` (`GIT_ROOT`) | one bare repository per project; served by `git http-backend` at `/api/git/<project id>.git` |
| `data/sync/media/<hashed account>/<sha256>` | `/data/sync` (`SYNC_ROOT`) | chat pictures, content-addressed; the index and quota live in SQLite |

Conversation bodies are gzipped JSON rows in `signups.sqlite` (`sync_chats`,
`sync_projects`, `sync_media`, `sync_state`); the cursor lives in
`sync_state.next_seq`. Hook Workspace lives in the same database
(`ws_projects`, `ws_members`, `ws_invites`, `ws_folders`, `ws_boards`,
`ws_tasks`, `ws_comments`, `ws_documents`, `ws_seq`), with one global `seq`
instead of a per-account cursor: `/api/ws/changes` filters by membership at read
time, so a workspace row is written once and every member pulls it at their own
pace. Access is per project, checked on every request; nothing is stored per
device. Back up the whole `data/` directory together — the repositories, the
pictures and the database reference each other.

The runtime image installs `git` (`apt-get install git`) and runs a `pre-receive`
hook on every repository. It rejects a push that would take a project over
200 MB or an account over 1 GB, before anything is written. Both limits are
server constants (`server/git.mjs`); the hook lives at
`server/git-policy.mjs`. A daily `git gc --auto` runs in the background after a
push, at most once an hour per repository.

Workspace quotas are server constants in `server/workspace.mjs` (200 projects,
100 members, 200 boards, 5,000 documents, 20,000 tasks per project, 512 KB per
document, 16 KB per comment). Deleting a project is a tombstone the changes feed
carries to every member; the rows stay in SQLite so a late pull cannot resurrect
the project.

The account's storage is removed by `DELETE /api/sync/account` (app token), which
drops the chat/project/media rows for that account, deletes both hashed folders,
and removes Workspace: every project the account owns with everything in it, plus
its memberships and invitations elsewhere. Other people's projects keep their
boards and documents.

Not in this directory because it must **never** be committed:

| File | Lives on the server at | Contents |
|------|------------------------|----------|
| `.env` | `/opt/hook-web/.env` (chmod 600) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `WAITLIST_SESSION_SECRET`, `HOOK_PROVIDER_SECRET`, `WAITLIST_ORIGIN`, `WAITLIST_DB_PATH`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_API_KEY`, `HOOK_MODEL_ID`, `OPENROUTER_BASE_URL`, `OPENROUTER_IMAGE_MODEL`, `OPENROUTER_API_KEY`, `DOWNLOAD_DIR`, `GIT_ROOT`, `SYNC_ROOT`, `PORT` |

`HOOK_PROVIDER_SECRET` (32+ characters, generated by `scripts/deploy-waitlist.sh`)
encrypts the personal model keys a paid account syncs (`server/provider.mjs`:
AES-256-GCM, the account subject as additional data). Without it the service
still runs — `/api/provider` answers `provider_sync_unavailable` and every app
keeps its key to itself. Rotating it makes the stored keys unreadable; each user
heals that by saving their endpoint once more.

## Devices, the relay and remote previews

The account service is also the machine registry and the middleman for remote
work. Three routes, all under `/api`:

| Route | Purpose |
| --- | --- |
| `GET/PATCH/DELETE /api/devices` | The account's machines: name, platform, version, capabilities, last seen, the per-machine "accept remote work" switch. Removing one revokes its tokens. |
| WebSocket `/api/relay` | Presence, remote commands and live chat/agent frames. Hook and a headless install connect as **hosts**; Hook Workspace and the phone as **controllers**. Caddy already proxies WebSockets; `flush_interval -1` keeps them flowing. |
| `POST /api/remote/preview/ticket` + `*.preview.hookcode.io` | A preview page from a machine. The ticket is random and bound to (account, machine, chat); the page requests are tunnelled over that machine's outbound socket. No inbound port on the user's computer. |

The relay is **in-memory**: a deploy drops every socket and the clients
reconnect. Presence is therefore empty for a moment after a restart and
`last_seen_at` is what the UI shows. There is one container and one SQLite file;
if the relay ever needs more than one process, it needs a pub/sub layer first.

### The preview wildcard certificate

`*.preview.hookcode.io` is a DNS-only `A` record for the same VPS IP. The stock
`caddy:2` image has no DNS provider module, so the certificate is issued outside
Caddy:

1. The Cloudflare API token (`Zone:DNS:Edit` + `Zone:Read` for `hookcode.io`)
   lives in `/opt/hook-web/cloudflare.ini`, mode `0600`. It is never in the repo.
2. `certbot/dns-cloudflare` issues and renews the wildcard into
   `/opt/hook-web/preview/`, which the container already sees at
   `/srv/hook-web/preview/`.
3. `preview.caddy` points its `tls` at those files; `hook-preview-cert.cron`
   runs `renew --quiet` and reloads Caddy.

Verify after a deploy:

```bash
dig +short test.preview.hookcode.io          # the VPS IP
curl -sI https://test.preview.hookcode.io/    # a relay 401/404, never a TLS error
openssl s_client -connect test.preview.hookcode.io:443   -servername test.preview.hookcode.io </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer        # CN=*.preview.hookcode.io
```

## Two hand edits to `/opt/scout` (outside this repo)

Hook is served by the shared `scout-caddy-1` container, which only sees what
`/opt/scout/docker-compose.yml` mounts. One-time setup:

```yaml
# /opt/scout/docker-compose.yml → services.caddy.volumes
      - /opt/hook-web:/srv/hook-web:ro
```

```
# /opt/scout/Caddyfile
import /srv/hook-web/*.caddy
```

then

```bash
cd /opt/scout && docker compose up -d --force-recreate caddy
```

The mount has to be re-added if `/opt/scout` is ever redeployed from its own
git repo (`docker-compose.yml` gets reset there) — the same caveat that already
applies to the `/opt/bentimor-com` mount. `deploy-waitlist.sh` warns when the
import line has gone missing.

## Why a container instead of static files

bentimor.com is pure static output, so Caddy serves it straight from disk. Hook's
landing page also needs `/api/*` (Google OAuth, desktop device login, SQLite,
the model proxy and the installer download), and the VPS has no Node runtime, so
the API runs as a container. Caddy still
serves the static build itself, which means a rebuild of the API or a missing
`/opt/hook-web/.env` never takes the marketing page down.

## AI content reports

`ai_reports` in the same SQLite database holds in-app reports of inappropriate
AI output (Microsoft Store policy 11.16). Review them from the dev machine:

```bash
./scripts/ai-reports.sh --list
./scripts/ai-reports.sh --show 12
./scripts/ai-reports.sh --resolve 12
```

## Common commands

```bash
cd /opt/hook-web
docker compose logs -f waitlist          # OAuth errors, "Google sign-in failed"
docker compose up -d                     # after editing .env
docker compose up -d --build waitlist    # rebuild from ./app
```

Who signed up — from the dev machine, no sqlite3 or Node needed locally:

```bash
./scripts/waitlist-people.sh             # table, newest first
./scripts/waitlist-people.sh --csv       # profiles, choices, prices, progress
./scripts/waitlist-people.sh --events    # individual onboarding actions as CSV
./scripts/waitlist-people.sh --count     # just the number

./scripts/waitlist-admin.sh --list                     # status + usage roll-up
./scripts/waitlist-admin.sh --approve someone@x.com    # unlock the app + proxy
./scripts/waitlist-admin.sh --revoke someone@x.com     # take access away now
./scripts/waitlist-admin.sh --delete someone@x.com     # remove the row + usage
./scripts/waitlist-admin.sh --usage-chats              # per-conversation tokens
./scripts/waitlist-admin.sh --usage-agents             # per coding-agent run
```

Backups are just a copy of `/opt/hook-web/data/signups.sqlite` (plus the `-wal`
file while the container is running). The Windows installer lives in
`/opt/hook-web/data/releases/` and is replaced atomically by the GitHub release
workflow; it is not part of the container image.
