# syntax=docker/dockerfile:1
#
# Hook landing page + waitlist API (server/waitlist.mjs).
#
# Built on the MoonRock VPS by scripts/deploy-waitlist.sh. In production Caddy
# serves the static build from /opt/hook-web/site and proxies /api/waitlist/*
# to this container; the copy of dist-waitlist below only keeps the image
# self-sufficient (you can run it standalone with `docker run -p 5173:5173`).

FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10
# Manifests first, source after: the install layer is then only invalidated by a
# dependency change instead of by every edit. The lockfile resolves against the
# workspace members, so their package.json files are needed here too.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/chat/package.json apps/chat/package.json
COPY apps/workspace/package.json apps/workspace/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/chat/package.json packages/chat/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm waitlist:build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# git runs Hook's private project repositories (git http-backend + hooks).
# The repositories live under the persisted /data volume.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10
# Only the manifests: the workspace members are needed to resolve the lockfile,
# not to run the server, and shipping their source would rebuild this layer on
# every UI change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/chat/package.json apps/chat/package.json
COPY apps/workspace/package.json apps/workspace/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/chat/package.json packages/chat/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile --ignore-scripts
COPY server ./server
COPY waitlist/content.json ./waitlist/content.json
COPY release.config.json ./release.config.json
COPY --from=build /app/dist-waitlist ./dist-waitlist

# node:24-slim ships uid/gid 1000 as "node"; /data is the SQLite directory
# (bind-mounted from /opt/hook-web/data, so it must stay writable by 1000).
RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV PORT=5173 \
    WAITLIST_DB_PATH=/data/signups.sqlite \
    DOWNLOAD_DIR=/data/releases \
    GIT_ROOT=/data/git \
    SYNC_ROOT=/data/sync
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/waitlist/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/waitlist.mjs"]
