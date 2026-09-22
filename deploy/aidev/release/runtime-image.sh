#!/usr/bin/env bash
# The ONLY image build in the system, and it never contains application code.
#   runtime-image.sh build [tag]    build aidev/cloudcli-runtime:<tag> (default: tools-<date>) and tag :latest
#   runtime-image.sh list
# Run it when a tool version changes (CLAUDE_CODE_VERSION, SDB, adb, node). Runtimes pick the
# new image up when they are next (re)created: `docker rm` a stopped runtime, or ask
# runtime-manager to start it; running ones can be cycled one at a time with
#   docker stop <c> && docker rm <c> && <login or release.sh restart-free start via manager>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); DEPLOY=$(cd "$here/.." && pwd)
ENV_FILE="$DEPLOY/.env"; [ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a
case "${1:-}" in
  build)
    tag="${2:-tools-$(date +%Y%m%d)}"
    echo "==> building aidev/cloudcli-runtime:$tag (Claude Code ${CLAUDE_CODE_VERSION:?})"
    DOCKER_BUILDKIT=1 docker build -f "$DEPLOY/runtime/Dockerfile" "$DEPLOY/runtime" \
      --build-arg CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" \
      --build-arg SDB_TARBALL_URL="${SDB_TARBALL_URL:-}" --build-arg SDB_SHA256="${SDB_SHA256:-}" \
      -t "aidev/cloudcli-runtime:$tag" 2>&1 | tail -15
    docker tag "aidev/cloudcli-runtime:$tag" aidev/cloudcli-runtime:latest
    echo " ✓ aidev/cloudcli-runtime:latest -> $tag" ;;
  list) docker images aidev/cloudcli-runtime ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
