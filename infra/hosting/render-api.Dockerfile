# syntax=docker/dockerfile:1
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --ignore-scripts --min-release-age=0
COPY apps/api apps/api
RUN npm run build -w @practice/api
RUN npm prune --omit=dev --ignore-scripts --min-release-age=0

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY infra/hosting ./infra/hosting
COPY infra/aws/rds-ca.crt ./infra/aws/rds-ca.crt
WORKDIR /app/apps/api
USER node
EXPOSE 3001
CMD ["node", "/app/infra/hosting/cloud-runtime.mjs"]
