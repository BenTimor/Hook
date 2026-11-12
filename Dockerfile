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
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm waitlist:build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY server ./server
COPY waitlist/content.json ./waitlist/content.json
COPY --from=build /app/dist-waitlist ./dist-waitlist

# node:24-slim ships uid/gid 1000 as "node"; /data is the SQLite directory
# (bind-mounted from /opt/hook-web/data, so it must stay writable by 1000).
RUN mkdir -p /data && chown -R node:node /app /data
USER node

ENV PORT=5173 \
    WAITLIST_DB_PATH=/data/signups.sqlite
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/waitlist/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/waitlist.mjs"]
