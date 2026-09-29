# aidev/cloudcli-runtime — tools only. Contains NO application code.
# Application code (CloudCLI dist/dist-server, node_modules, entrypoint) comes from the
# shared release volume mounted at /srv/app; see deploy/aidev/release/README.md.
# Rebuild only when a tool version changes (Claude Code, SDB, adb, node).
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION
ARG SDB_TARBALL_URL
ARG SDB_SHA256
RUN test -n "$CLAUDE_CODE_VERSION" && apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client adb ca-certificates curl libstdc++6 libusb-1.0-0 unzip procps ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && useradd --uid 1001 --create-home --shell /bin/bash cloudcli
# SDB is vendor-distributed; injected at build time when a checksum-verified archive is configured.
RUN mkdir -p /opt/tizen-tools /srv/app \
 && if [ -n "$SDB_TARBALL_URL" ]; then curl -fsSL "$SDB_TARBALL_URL" -o /tmp/sdb.zip && echo "$SDB_SHA256  /tmp/sdb.zip" | sha256sum -c - && unzip -q /tmp/sdb.zip -d /opt/tizen-tools && install -m 0755 /opt/tizen-tools/data/tools/sdb /usr/local/bin/sdb && rm /tmp/sdb.zip; fi \
 && mkdir -p /workspace /home/cloudcli/.cloudcli \
 && chown -R 1001:1001 /workspace /home/cloudcli
ENV HOME=/home/cloudcli PATH=/opt/tizen-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
 HOST=0.0.0.0 SERVER_PORT=3001 DATABASE_PATH=/home/cloudcli/.cloudcli/auth.db VITE_IS_PLATFORM=false
USER 1001:1001
WORKDIR /workspace
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/srv/app/current/runtime/entrypoint.mjs"]
