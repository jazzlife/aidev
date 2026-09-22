FROM node:22-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 git && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/cloudcli
COPY package*.json ./
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3 bcrypt node-pty
# Everything above is cached until package*.json changes; a source-only release
# re-runs only the steps below (tsc + vite, ~1 min) on the AI-PC.
COPY . .
ENV VITE_IS_PLATFORM=false
ARG AIDEV_RELEASE=dev
RUN npm run build && npm prune --omit=dev --ignore-scripts && echo "$AIDEV_RELEASE" > dist-server/AIDEV_RELEASE

FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION
ARG SDB_TARBALL_URL
ARG SDB_SHA256
RUN test -n "$CLAUDE_CODE_VERSION" && apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client adb ca-certificates curl libstdc++6 libusb-1.0-0 unzip \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && useradd --uid 1001 --create-home --shell /bin/bash cloudcli
WORKDIR /opt/cloudcli
COPY --from=build /opt/cloudcli/package*.json ./
COPY --from=build /opt/cloudcli/node_modules ./node_modules
COPY --from=build /opt/cloudcli/dist ./dist
COPY --from=build /opt/cloudcli/dist-server ./dist-server
COPY --from=build /opt/cloudcli/shared ./shared
COPY --from=build /opt/cloudcli/public ./public
COPY deploy/aidev/cloudcli/entrypoint.mjs ./aidev-entrypoint.mjs
# SDB is vendor-distributed. An approved archive can be injected at build time;
# the base image remains useful for hosts that do not manage Tizen devices.
RUN mkdir -p /opt/tizen-tools \
 && if [ -n "$SDB_TARBALL_URL" ]; then curl -fsSL "$SDB_TARBALL_URL" -o /tmp/sdb.zip && echo "$SDB_SHA256  /tmp/sdb.zip" | sha256sum -c - && unzip -q /tmp/sdb.zip -d /opt/tizen-tools && install -m 0755 /opt/tizen-tools/data/tools/sdb /usr/local/bin/sdb && rm /tmp/sdb.zip; fi \
 && mkdir -p /workspace /home/cloudcli/.cloudcli \
 && chown -R 1001:1001 /workspace /home/cloudcli
ENV HOME=/home/cloudcli PATH=/opt/tizen-tools:/opt/cloudcli/node_modules/.bin:$PATH \
 HOST=0.0.0.0 SERVER_PORT=3001 DATABASE_PATH=/home/cloudcli/.cloudcli/auth.db VITE_IS_PLATFORM=false
USER 1001:1001
WORKDIR /workspace
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/opt/cloudcli/aidev-entrypoint.mjs"]
