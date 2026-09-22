#!/usr/bin/env bash
# One-time migration of the running Phase 1 stack onto the release tooling.
#   bootstrap.sh <payload-dir>      payload has repo.tgz (this repo incl. .git) and dist.tgz
# Steps, each idempotent:
#   1. install the repo at ~/aidev/repo (the old ~/aidev/source is left untouched)
#   2. create deploy/aidev/.env from the values the running stack already uses
#   3. put the current frontend build into the shared volume as the first release
#   4. rebuild the gateway (serves the SPA from the volume) and replace it — the
#      runtime-manager and every user container keep running
#   5. tag deployed/current so later deploys are incremental
set -euo pipefail
payload="${1:?payload dir}"; payload=$(cd "$payload" && pwd)
REPO="$HOME/aidev/repo"

if [ ! -d "$REPO/.git" ]; then
  mkdir -p "$REPO"; tar xzf "$payload/repo.tgz" -C "$REPO"
  echo "==> repo installed at $REPO: $(git -C "$REPO" log --oneline -1)"
else
  echo "==> repo already present: $(git -C "$REPO" log --oneline -1)"
fi
git -C "$REPO" remote get-url upstream >/dev/null 2>&1 || git -C "$REPO" remote add upstream https://github.com/siteboon/claudecodeui.git
chmod +x "$REPO"/deploy/aidev/release/*.sh
. "$REPO/deploy/aidev/release/lib.sh"

if [ ! -f "$ENV_FILE" ]; then
  sed 's/^AIDEV_PROXY_NETWORK=.*/AIDEV_PROXY_NETWORK=npm_bridge/; s#^AIDEV_SECRET_DIR=.*#AIDEV_SECRET_DIR=/home/turtlelab/aidev/secrets#' "$DEPLOY/.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"; echo "==> wrote $ENV_FILE"
fi
load_env
[ -f "$AIDEV_SECRET_DIR/gateway-jwt" ] || fail "secrets not found in $AIDEV_SECRET_DIR"
docker network inspect "$AIDEV_PROXY_NETWORK" >/dev/null || fail "proxy network $AIDEV_PROXY_NETWORK missing"

log "sanity: current stack"
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep '^aidev-' || fail "aidev stack is not running"
gateway_health && ok "gateway reachable on $AIDEV_PROXY_NETWORK"

sha=$(git_sha)
log "frontend volume: first release $sha"
docker volume inspect "$FRONTEND_VOLUME" >/dev/null 2>&1 || docker volume create --label com.docker.compose.project=aidev --label com.docker.compose.volume=frontend "$FRONTEND_VOLUME" >/dev/null
"$DEPLOY/release/frontend.sh" "$payload/dist.tgz" "$sha"

log "gateway: build + replace (serves SPA from volume for all users)"
"$DEPLOY/release/stack.sh" gateway

# Record the image the running user containers were built from, for rollback bookkeeping.
docker image inspect aidev/cloudcli:dynamic --format '{{.Id}}' > "$STATE_DIR/cloudcli.bootstrap-image"
echo "phase1-2026-09-18" > "$STATE_DIR/cloudcli.current"

git -C "$REPO" tag -f deployed/current >/dev/null
git -C "$REPO" tag -f "deployed/$(date +%Y%m%d-%H%M%S)-$sha" >/dev/null
"$DEPLOY/release/stack.sh" status
echo "DEPLOYED_SHA=$(git -C "$REPO" rev-parse HEAD)"
