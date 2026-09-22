FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
ARG AIDEV_GATEWAY_VERSION=dev
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The SPA is not baked in: /srv/frontend is a shared volume managed by
# deploy/aidev/release/frontend.sh (releases/<id>/ + `current` symlink).
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin gateway \
 && mkdir -p /data /srv/frontend && chown 1001:1001 /data /srv/frontend
USER 1001:1001
ENV PORT=8080 DATABASE_PATH=/data/auth.db STATIC_ROOT=/srv/frontend/current AIDEV_GATEWAY_VERSION=${AIDEV_GATEWAY_VERSION}
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/_gateway/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/auth-gateway.js"]
