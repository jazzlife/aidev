FROM aidev/cloudcli:dynamic AS ui
FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=ui /opt/cloudcli/public /app/static
COPY --from=ui /opt/cloudcli/dist /app/static
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin gateway && mkdir /data && chown 1001:1001 /data
USER 1001:1001
ENV PORT=8080 DATABASE_PATH=/data/auth.db
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/_gateway/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/auth-gateway.js"]
