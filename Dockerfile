# syntax=docker/dockerfile:1
# NOT BUILT OR RUN in the authoring environment (no Docker available). Treat as unverified
# until CI or an operator has built it. See docs/DEPLOYMENT.md.
#
# Targets:
#   build : full workspace with dev dependencies; used to compile web + API
#   tools : build + source, for one-off operations (pnpm db:migrate, pnpm db:seed)
#   app   : default. Production dependencies, built API bundle, static web build.

ARG NODE_VERSION=24.22.0
ARG PNPM_VERSION=10.33.4

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV CI=true
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM build AS tools
ENV NODE_ENV=production
CMD ["pnpm", "db:migrate"]

FROM node:${NODE_VERSION}-bookworm-slim AS app
ARG PNPM_VERSION
ENV NODE_ENV=production CI=true
RUN npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/platform/package.json packages/platform/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/integrations/package.json packages/integrations/package.json
# Hoisted layout so the bundled API in dist/api resolves its external dependencies from
# /app/node_modules. Only API production dependencies are installed.
RUN pnpm install --frozen-lockfile --prod --filter "@opentradie/api..." --config.node-linker=hoisted \
    && pnpm store prune
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Drop root. The API serves apps/web/dist relative to its working directory.
RUN useradd --system --uid 10001 --no-create-home opentradie && mkdir -p /app/.data && chown opentradie /app/.data
USER opentradie
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/api/server.js"]
