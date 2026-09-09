# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS workspace-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/managed-runtime/package.json packages/managed-runtime/package.json
COPY packages/test-support/package.json packages/test-support/package.json
RUN npm ci
COPY tsconfig.base.json eslint.config.js vitest.config.ts vitest.integration.config.ts ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build:workspaces

FROM node:22-bookworm-slim AS production-manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/managed-runtime/package.json packages/managed-runtime/package.json
COPY packages/test-support/package.json packages/test-support/package.json
COPY scripts/prune-production-deps.mjs scripts/prune-production-deps.mjs

FROM production-manifests AS api-production-deps
RUN npm ci --omit=dev \
    --workspace @onepic/api \
    --workspace @onepic/contracts \
    --workspace @onepic/managed-runtime \
    --include-workspace-root=false \
    && node scripts/prune-production-deps.mjs api contracts managed-runtime \
    && npm prune --omit=dev \
    && rm -rf node_modules/@img/sharp-wasm32 node_modules/@emnapi/runtime node_modules/tslib

FROM production-manifests AS worker-production-deps
RUN npm ci --omit=dev \
    --workspace @onepic/worker \
    --workspace @onepic/contracts \
    --workspace @onepic/managed-runtime \
    --include-workspace-root=false \
    && node scripts/prune-production-deps.mjs worker contracts managed-runtime \
    && npm prune --omit=dev \
    && rm -rf node_modules/@img/sharp-wasm32 node_modules/@emnapi/runtime node_modules/tslib

FROM node:22-bookworm-slim AS node-production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=workspace-build /app/packages/managed-runtime/package.json ./packages/managed-runtime/package.json
COPY --from=workspace-build /app/packages/managed-runtime/dist ./packages/managed-runtime/dist
COPY NOTICE.md LICENSE /licenses/
COPY third_party /licenses/third_party
RUN mkdir -p /var/lib/onepic/media \
    && chown -R node:node /var/lib/onepic \
    && chmod -R a+rX /licenses /app/package.json /app/package-lock.json /app/packages/managed-runtime
USER node

FROM node-production AS api
COPY --from=api-production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=api-production-deps /app/package.json ./package.json
COPY --chown=node:node --from=api-production-deps /app/apps/api/package.json ./apps/api/package.json
COPY --chown=node:node --from=api-production-deps /app/packages/managed-runtime/package.json ./packages/managed-runtime/package.json
COPY --chown=node:node --from=workspace-build /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node --from=workspace-build /app/apps/api/migrations ./apps/api/migrations
COPY --chown=node:node --from=api-production-deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=node:node --from=workspace-build /app/packages/contracts/openapi ./packages/contracts/openapi
COPY --chown=node:node --from=workspace-build /app/packages/contracts/dist ./packages/contracts/dist
COPY --chown=node:node public/data/catalog.json ./public/data/catalog.json
COPY --chown=node:node public/data/prompts ./public/data/prompts
COPY --chown=node:node data/library/templates.json ./data/library/templates.json
RUN chmod -R a+rX /app/apps/api /app/packages/contracts /app/public/data /app/data/library
EXPOSE 8080
CMD ["sh", "-ec", "if [ \"${RUN_MODE:-catalog-only}\" = \"managed-generation\" ]; then : \"${DATABASE_URL:?DATABASE_URL is required in managed-generation mode}\"; node apps/api/dist/db/migrate-cli.js || exit 1; node apps/api/dist/modules/catalog/import-cli.js || exit 1; fi; exec node apps/api/dist/server.js"]

FROM node-production AS worker
COPY --from=worker-production-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=worker-production-deps /app/package.json ./package.json
COPY --chown=node:node --from=worker-production-deps /app/apps/worker/package.json ./apps/worker/package.json
COPY --chown=node:node --from=worker-production-deps /app/packages/managed-runtime/package.json ./packages/managed-runtime/package.json
COPY --chown=node:node --from=workspace-build /app/apps/worker/dist ./apps/worker/dist
COPY --chown=node:node --from=worker-production-deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=node:node --from=workspace-build /app/packages/contracts/dist ./packages/contracts/dist
RUN chmod -R a+rX /app/apps/worker /app/packages/contracts
CMD ["node", "apps/worker/dist/index.js"]

FROM nginx:1.27-alpine AS web
COPY ops/nginx/container.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
COPY --from=workspace-build /app/apps/web/dist /usr/share/nginx/html
COPY NOTICE.md LICENSE /licenses/
COPY third_party /licenses/third_party
RUN chmod -R a+rX /usr/share/nginx/html /licenses
EXPOSE 8080

FROM nginx:1.27-alpine AS static
COPY ops/nginx/static-container.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
COPY NOTICE.md LICENSE /licenses/
COPY third_party /licenses/third_party
RUN chmod -R a+rX /usr/share/nginx/html /licenses
EXPOSE 8080
