FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpm-approve-builds ./
RUN pnpm install --frozen-lockfile

COPY . .

# Public variables are bundled into the Next.js client at build time.
ENV NEXT_PUBLIC_APP_LABEL=Ptylon \
    NEXT_PUBLIC_WS_PORT=8791 \
    NEXT_PUBLIC_WORKSPACE_ROOT=/workspace \
    NEXT_PUBLIC_UPLOAD_DIR=/workspace/uploads

RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /workspace/uploads \
  && chown -R node:node /app /data /workspace

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=8790 \
    WORKSPACE_ROOT=/workspace \
    FILE_ACCESS_ROOT=/workspace \
    ALLOWED_CWD_ROOT=/workspace \
    UPLOAD_DIR=/workspace/uploads \
    WEB_CONSOLE_DB_PATH=/data/ptylon.db

CMD ["node", "server.js"]
