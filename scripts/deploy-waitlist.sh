#!/usr/bin/env bash
#
# Deploy the Hook landing page + waitlist API to the MoonRock VPS.
#
#   ./scripts/deploy-waitlist.sh
#
# What it does:
#   1. builds the site locally (tsc + vite → dist-waitlist/), unless SKIP_BUILD=1
#      (GitHub Actions builds once in the verify job and passes the artifact on)
#   2. fingerprints what the server container runs (scripts/site-source-hash.mjs)
#      and streams the source into /opt/hook-web/app only when that changed
#   3. streams dist-waitlist/ into /opt/hook-web/site (served by Caddy)
#   4. syncs docker-compose.yml + hookcode.caddy, reloads Caddy only if changed
#   5. rebuilds and restarts the hook-waitlist container only when the image
#      changed; a site-only deploy leaves the API running untouched
#   6. probes the live routes
#
# REBUILD_IMAGE=1 forces step 5 and records the new fingerprint afterwards.
#
# Secrets never leave the server: /opt/hook-web/.env is created once with a
# generated session secret and left alone on later deploys. Add your Google
# OAuth client ID/secret there, then `cd /opt/hook-web && docker compose up -d`.
#
# SSH uses your agent (Bitwarden) when it is available and falls back to
# ~/.ssh/hetzner_root. Override the target with DEPLOY_HOST / DEPLOY_DIR /
# DEPLOY_DOMAIN / DEPLOY_KEY if the server moves.
#
set -euo pipefail

HOST="${DEPLOY_HOST:-root@167.233.58.139}"
DIR="${DEPLOY_DIR:-/opt/hook-web}"
DOMAIN="${DEPLOY_DOMAIN:-hookcode.io}"
CADDY_CONTAINER="${CADDY_CONTAINER:-scout-caddy-1}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

# Use a local key when one exists; the agent still works as a second identity
# (Bitwarden's agent is not always running).
SSH_KEY="${DEPLOY_KEY:-$HOME/.ssh/hetzner_root}"
if [ -f "$SSH_KEY" ]; then SSH_OPTS+=(-i "$SSH_KEY"); fi

# On Windows/git-bash, the Bitwarden agent is exposed as a named pipe
# (SSH_AUTH_SOCK=//./pipe/openssh-ssh-agent) which only the Windows OpenSSH
# binary can talk to. Prefer it when it exists.
if [ -z "${SSH_BIN:-}" ]; then
  for candidate in /c/Windows/System32/OpenSSH/ssh.exe ssh; do
    if command -v "$candidate" >/dev/null 2>&1; then SSH_BIN="$candidate"; break; fi
  done
fi

cd "$(dirname "$0")/.."

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
ssh_do() { "$SSH_BIN" "${SSH_OPTS[@]}" "$HOST" "$@"; }

if [ "${SKIP_BUILD:-0}" = 1 ]; then
  step "Using prebuilt dist-waitlist/ (SKIP_BUILD=1)"
  if [ ! -f dist-waitlist/index.html ]; then
    echo "  !! dist-waitlist/index.html missing — run pnpm waitlist:build first" >&2
    exit 1
  fi
else
  step "Building"
  pnpm waitlist:build
fi

# The container only has to be rebuilt when something it runs changed. The
# fingerprint is recorded on the server by the last rebuild, so a copy, layout
# or stylesheet change ships the static build alone: twenty seconds instead of
# a cold `pnpm install` on the box.
IMAGE_HASH="$(node scripts/site-source-hash.mjs)"
REMOTE_HASH="$(ssh_do "cat '$DIR/.image-hash' 2>/dev/null || true" | tr -d '\r\n')"
if [ "${REBUILD_IMAGE:-0}" = 1 ] || [ "$IMAGE_HASH" != "$REMOTE_HASH" ]; then
  IMAGE_CHANGED=1
  step "Uploading source → $HOST:$DIR/app (image ${IMAGE_HASH:0:11})"
  # Only tracked / gitignore-visible files: src-tauri is 11 GB locally and none
  # of it is needed for the waitlist image.
  FILES="$(mktemp)"
  trap 'rm -f "$FILES"' EXIT
  git ls-files --cached --others --exclude-standard \
    | grep -v -e '^src-tauri/' -e '^harness\.config' > "$FILES"
  tar --owner=0 --group=0 --numeric-owner -czf - -T "$FILES" |
    ssh_do "rm -rf '$DIR/app' && mkdir -p '$DIR/app' && tar -xzf - -C '$DIR/app'"
  echo "  $(wc -l < "$FILES") files"
else
  IMAGE_CHANGED=0
  step "Server image unchanged (${IMAGE_HASH:0:11})"
fi
step "Uploading dist-waitlist/ → $HOST:$DIR/site"
tar --owner=0 --group=0 --numeric-owner -czf - -C dist-waitlist . |
  ssh_do "rm -rf '$DIR/site' && mkdir -p '$DIR/site' && tar -xzf - -C '$DIR/site'"

COMPOSE_CHANGED=0
step "Syncing $DIR/docker-compose.yml"
ssh_do "cat > '$DIR/docker-compose.yml.new'" < infra/docker-compose.yml
if ssh_do "cmp -s '$DIR/docker-compose.yml' '$DIR/docker-compose.yml.new'"; then
  ssh_do "rm -f '$DIR/docker-compose.yml.new'"
  echo "  unchanged"
else
  ssh_do "mv '$DIR/docker-compose.yml.new' '$DIR/docker-compose.yml'"
  echo "  updated"
  COMPOSE_CHANGED=1
fi

CADDY_CHANGED=0
for CADDY_FILE in hookcode.caddy preview.caddy; do
  step "Syncing $DIR/$CADDY_FILE"
  ssh_do "cat > '$DIR/$CADDY_FILE.new'" < "infra/$CADDY_FILE"
  if ssh_do "cmp -s '$DIR/$CADDY_FILE' '$DIR/$CADDY_FILE.new'"; then
    ssh_do "rm -f '$DIR/$CADDY_FILE.new'"
    echo "  unchanged"
  else
    ssh_do "mv '$DIR/$CADDY_FILE.new' '$DIR/$CADDY_FILE'"
    echo "  updated"
    CADDY_CHANGED=1
  fi
done

# The wildcard certificate for *.preview.hookcode.io is renewed by certbot's
# Cloudflare DNS-01 plugin, outside Caddy, and Caddy is reloaded afterwards.
step "Installing the preview certificate renewal"
ssh_do "cat > /etc/cron.d/hook-preview-cert" < infra/hook-preview-cert.cron
ssh_do "chmod 644 /etc/cron.d/hook-preview-cert"

step "Bootstrapping $DIR/.env + data volume"
ssh_do "DIR='$DIR' DOMAIN='$DOMAIN' bash -s" <<'REMOTE'
set -euo pipefail
mkdir -p "$DIR/site" "$DIR/data" "$DIR/data/releases"
# The container runs as uid 1000 (node) and writes the SQLite file here.
chown 1000:1000 "$DIR/data" "$DIR/data/releases"
if [ ! -s "$DIR/.env" ]; then
  cat > "$DIR/.env" <<ENV
WAITLIST_ORIGIN=https://$DOMAIN
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
WAITLIST_SESSION_SECRET=$(openssl rand -hex 32)
HOOK_PROVIDER_SECRET=$(openssl rand -hex 32)
WAITLIST_DB_PATH=/data/signups.sqlite
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_API_KEY=
HOOK_MODEL_ID=hook
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_IMAGE_MODEL=meta/muse-image
OPENROUTER_IMAGE_FORMAT=png
OPENROUTER_API_KEY=
DOWNLOAD_DIR=/data/releases
PORT=5173
ENV
  chmod 600 "$DIR/.env"
  echo "  created .env — Google credentials are still empty"
else
  # Existing deployments predate the API proxy. Add any missing keys without
  # touching values that are already configured.
  ensure_env() {
    key="$1"; value="$2"
    if ! grep -q "^$key=" "$DIR/.env"; then
      printf '%s=%s\n' "$key" "$value" >> "$DIR/.env"
      echo "  added $key to .env"
    fi
  }
  ensure_env DEEPSEEK_BASE_URL https://api.deepseek.com
  ensure_env DEEPSEEK_MODEL deepseek-flash
  ensure_env DEEPSEEK_API_KEY ""
  ensure_env HOOK_MODEL_ID hook
  # Picture generation (server/images.mjs). The key stays here and never reaches
  # a build; empty means the tools answer "not set up" instead of failing later.
  ensure_env OPENROUTER_BASE_URL https://openrouter.ai/api/v1
  ensure_env OPENROUTER_IMAGE_MODEL meta/muse-image
  ensure_env OPENROUTER_IMAGE_FORMAT png
  ensure_env OPENROUTER_API_KEY ""
  ensure_env DOWNLOAD_DIR /data/releases
  # Encrypts the personal model keys a paid account syncs (server/provider.mjs).
  # Generated once; rotating it makes saved keys unreadable, which the app heals
  # by the user saving the endpoint again.
  ensure_env HOOK_PROVIDER_SECRET "$(openssl rand -hex 32)"
  echo "  kept existing .env"
fi
if ! grep -q 'import /srv/hook-web' /opt/scout/Caddyfile 2>/dev/null; then
  echo "  !! /opt/scout/Caddyfile lost its 'import /srv/hook-web/*.caddy' line"
  echo "     (a scout redeploy resets it — re-add the import + the caddy volume)"
fi
REMOTE

if [ "$IMAGE_CHANGED" = 1 ]; then
  step "Rebuilding hook-waitlist"
  ssh_do "cd '$DIR' && docker compose build waitlist" 2>&1 | tail -6
elif [ "$COMPOSE_CHANGED" = 1 ]; then
  step "Recreating hook-waitlist (docker-compose.yml changed)"
else
  step "Container left alone"
fi

if [ "$IMAGE_CHANGED" = 1 ] || [ "$COMPOSE_CHANGED" = 1 ]; then
  if ssh_do "grep -q '^GOOGLE_CLIENT_ID=.' '$DIR/.env'"; then
    ssh_do "cd '$DIR' && docker compose up -d --no-deps waitlist" 2>&1 | tail -4
  else
    # Without OAuth credentials the API deliberately refuses to boot (that is what
    # stops a half-configured production deploy from going live). Create/replace the
    # container but leave it stopped instead of letting it crash-loop.
    ssh_do "cd '$DIR' && docker compose up -d --no-deps --no-start waitlist >/dev/null 2>&1 || true
            cd '$DIR' && docker compose stop waitlist >/dev/null 2>&1 || true"
    echo "  API left stopped: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are empty in $DIR/.env"
    echo "  Landing page serves fine; the signup button reports sign-in unavailable."
  fi
else
  echo "  site updated, API untouched (nothing it runs changed)"
fi

# Only a rebuild that actually happened may claim the fingerprint; a failed
# deploy retries the rebuild on the next run instead of shipping a stale image.
if [ "$IMAGE_CHANGED" = 1 ]; then
  ssh_do "printf '%s\n' '$IMAGE_HASH' > '$DIR/.image-hash' && chmod 644 '$DIR/.image-hash'"
fi

if [ "$CADDY_CHANGED" = 1 ]; then
  step "Reloading Caddy"
  ssh_do "docker exec $CADDY_CONTAINER caddy reload --config /etc/caddy/Caddyfile" 2>&1 | tail -3
fi

step "Verifying"
ssh_do "DIR='$DIR' DOMAIN='$DOMAIN' bash -s" <<'REMOTE'
cd "$DIR"
docker compose ps --format '  {{.Name}}: {{.Status}}'
probe() {
  local code
  if code=$(curl -ksS --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -w '%{http_code}' \
       "https://$DOMAIN$1" 2>/dev/null); then
    printf '  %-28s → HTTP %s\n' "$1" "$code"
  else
    printf '  %-28s → no TLS yet (is %s pointing here?)\n' "$1" "$DOMAIN"
  fi
}
probe /
probe /favicon.svg
probe /api/waitlist/status
probe /api/download/info
probe /api/releases
probe /api/v1/models
if [ ! -s "$DIR/data/releases/Hook-setup.exe" ]; then
  echo "  installer: not uploaded yet (pnpm release fills this)"
fi
if [ ! -s "$DIR/data/signups.sqlite" ]; then
  echo "  signups: none yet"
fi
if ! grep -q '^GOOGLE_CLIENT_ID=.' "$DIR/.env"; then
  echo "  next: put the OAuth client id/secret in $DIR/.env, then: docker compose up -d waitlist"
fi
REMOTE

printf '\n\033[32m✓ Deployed to %s\033[0m\n' "$HOST"
echo "  Live URL: https://$DOMAIN/"
