# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

# node-pty and better-sqlite3 have native components.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . ./
RUN pnpm build && pnpm prune --prod


FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system ptylon \
  && useradd --system --gid ptylon --create-home --home-dir /home/ptylon --shell /usr/sbin/nologin ptylon \
  && install -d -o ptylon -g ptylon /app /data /workspace /workspace/uploads

WORKDIR /app

COPY --from=build --chown=ptylon:ptylon /app/.next/standalone ./
COPY --from=build --chown=ptylon:ptylon /app/.next/static ./.next/static
COPY --from=build --chown=ptylon:ptylon /app/public ./public
COPY --from=build --chown=ptylon:ptylon /app/server ./server
COPY --from=build --chown=ptylon:ptylon /app/node_modules ./node_modules

ENV NODE_ENV=production \
    PORT=8790 \
    WS_PORT=8791 \
    WS_HOST=0.0.0.0 \
    PTY_DAEMON_HOST=0.0.0.0 \
    PTY_DAEMON_PORT=8792 \
    PTY_DAEMON_URL=ws://pty:8792 \
    WEB_CONSOLE_DB_PATH=/data/web-console.db \
    WORKSPACE_ROOT=/workspace \
    FILE_ACCESS_ROOT=/workspace \
    ALLOWED_CWD_ROOT=/workspace \
    UPLOAD_DIR=/workspace/uploads \
    NEXT_PUBLIC_WORKSPACE_ROOT=/workspace \
    NEXT_PUBLIC_UPLOAD_DIR=/workspace

USER ptylon
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
