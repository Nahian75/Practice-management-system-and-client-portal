# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --ignore-scripts --min-release-age=0
COPY apps/api apps/api
RUN npm run build -w @practice/api
RUN npm prune --omit=dev --ignore-scripts --min-release-age=0

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
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
