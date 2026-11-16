# infra/

Reference copies of the server-side configuration for the **Hook landing page**
(`hookcode.io`). Everything here is uploaded by `./scripts/deploy-waitlist.sh`
on every deploy — edit it *here*, not on the server.

| File | Lives on the server at | Purpose |
|------|------------------------|---------|
| `docker-compose.yml` | `/opt/hook-web/docker-compose.yml` | `hook-waitlist` container (built from `/opt/hook-web/app`), joins `scout_default`, SQLite bind-mounted from `/opt/hook-web/data` |
| `hookcode.caddy` | `/opt/hook-web/hookcode.caddy` | Caddy site block: serves `/opt/hook-web/site`, proxies `/api/*` (waitlist, device login, model proxy, download, release index) to the container, `www` → apex redirect |

`release.config.json` (repo root) is copied into the image by the Dockerfile. It
holds `minimumVersion`, the oldest desktop build allowed to keep working; raising
it forces older installs to update on their next check, without rebuilding the
app. It is shipped by `deploy-waitlist.sh` like any other tracked file.

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

Not in this directory because it must **never** be committed:

| File | Lives on the server at | Contents |
|------|------------------------|----------|
| `.env` | `/opt/hook-web/.env` (chmod 600) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `WAITLIST_SESSION_SECRET`, `WAITLIST_ORIGIN`, `WAITLIST_DB_PATH`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_API_KEY`, `HOOK_MODEL_ID`, `DOWNLOAD_DIR`, `PORT` |

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
./scripts/waitlist-people.sh --csv       # email,joined_at,google_subject
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
