# syntax=docker/dockerfile:1
# Built and smoke-tested locally and in CI (job "docker image" in .github/workflows/ci.yml).
# See docs/DEPLOYMENT.md.
#
# Targets:
#   build : full workspace with dev dependencies; compiles web + API + worker
#   tools : build + source, for one-off operations (pnpm db:migrate, pnpm db:seed)
#   deps  : production dependencies of the API and worker only (hoisted node_modules)
#   app   : default. Plain Node runtime, production node_modules, built bundles, static web build.
#
# Behind a TLS-intercepting proxy, pass its CA as an optional build secret (never baked into a layer):
#   docker build --secret id=build_ca,src=/path/to/ca.crt --build-arg HTTPS_PROXY=... .

ARG NODE_VERSION=24.22.0
# Must match "packageManager" in package.json.
ARG PNPM_VERSION=10.33.4

FROM node:${NODE_VERSION}-bookworm-slim AS pnpm
ARG PNPM_VERSION
ENV CI=true
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && npm install --global --no-fund --no-audit pnpm@${PNPM_VERSION} \
    && npm cache clean --force
WORKDIR /app

FROM pnpm AS build
COPY . .
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && pnpm install --frozen-lockfile && pnpm build

FROM build AS tools
ENV NODE_ENV=production
CMD ["pnpm", "db:migrate"]

FROM pnpm AS deps
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/platform/package.json packages/platform/package.json
# Hoisted layout so the bundles in dist/ resolve their external dependencies (pg, fastify,
# @react-pdf/renderer, ...) from /app/node_modules. Workspace packages are bundled, so their
# links are dropped. Only API and worker production dependencies are installed.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
    && pnpm install --frozen-lockfile --prod --ignore-scripts \
       --filter "@opentradie/api..." --filter "@opentradie/worker..." \
       --config.node-linker=hoisted \
    && rm -rf node_modules/@opentradie node_modules/.pnpm .pnpm-store

FROM node:${NODE_VERSION}-bookworm-slim AS app
# Listen on all interfaces of the container's own network namespace; host exposure is decided by
# the port mapping (compose binds 127.0.0.1 by default). With --network host, set HOST=127.0.0.1.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Drop root. The API serves apps/web/dist relative to its working directory.
RUN useradd --system --uid 10001 --no-create-home opentradie \
    && mkdir -p /app/.data && chown opentradie /app/.data
USER opentradie
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/api/server.js"]
