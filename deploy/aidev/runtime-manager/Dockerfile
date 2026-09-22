FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Docker Engine authorization is the only privileged capability in this
# service. The gateway and every CloudCLI runtime remain unprivileged.
ENV PORT=8090
CMD ["node", "dist/runtime-manager.js"]
