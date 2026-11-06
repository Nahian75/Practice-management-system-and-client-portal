# syntax=docker/dockerfile:1
FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --ignore-scripts --min-release-age=0
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1 CONTAINER_BUILD=1
RUN npm run build -w @practice/web

FROM caddy:2-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f AS edge
FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=10000 XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data
WORKDIR /app
COPY --from=edge /usr/bin/caddy /usr/local/bin/caddy
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY infra/hosting/render-web.mjs infra/hosting/render.Caddyfile ./infra/hosting/
USER node
EXPOSE 10000
CMD ["node", "infra/hosting/render-web.mjs"]
