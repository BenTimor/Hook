# infra/

Reference copies of the server-side configuration for the **Hook landing page**
(`hookcode.io`). Everything here is uploaded by `./scripts/deploy-waitlist.sh`
on every deploy — edit it *here*, not on the server.

| File | Lives on the server at | Purpose |
|------|------------------------|---------|
| `docker-compose.yml` | `/opt/hook-web/docker-compose.yml` | `hook-waitlist` container (built from `/opt/hook-web/app`), joins `scout_default`, SQLite bind-mounted from `/opt/hook-web/data` |
| `hookcode.caddy` | `/opt/hook-web/hookcode.caddy` | Caddy site block: serves `/opt/hook-web/site`, proxies `/api/waitlist/*` to the container, `www` → apex redirect |

Not in this directory because it must **never** be committed:

| File | Lives on the server at | Contents |
|------|------------------------|----------|
| `.env` | `/opt/hook-web/.env` (chmod 600) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `WAITLIST_SESSION_SECRET`, `WAITLIST_ORIGIN`, `WAITLIST_DB_PATH`, `PORT` |

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
landing page also needs `/api/waitlist/*` (Google OAuth code exchange + SQLite),
and the VPS has no Node runtime, so the API runs as a container. Caddy still
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
```

Backups are just a copy of `/opt/hook-web/data/signups.sqlite` (plus the `-wal`
file while the container is running).
