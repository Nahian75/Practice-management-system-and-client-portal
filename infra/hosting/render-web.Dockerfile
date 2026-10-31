# syntax=docker/dockerfile:1
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --ignore-scripts --min-release-age=0
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1 CONTAINER_BUILD=1
RUN npm run build -w @practice/web

FROM caddy:2-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f AS edge
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
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
