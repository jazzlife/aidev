#!/usr/bin/env bash
# One-time migration of the Phase 1 stack (code baked into images) to the release-volume
# model. Idempotent. Run from a payload dir containing release-<sha>.tgz and this repo's
# deploy/aidev/ tree (deploy.tgz).
#   bootstrap.sh <payload-dir>
# Order matters so the public endpoint is down for seconds, not minutes:
#   1. ~/aidev/deploy  <- deploy/aidev tree (compose, scripts, runtime Dockerfile); .env written
#   2. aidev_app volume <- release installed (deps built here once, several minutes) and activated
#   3. aidev/cloudcli-runtime:latest built (tools only, ~2-3 min, no app code)
#   4. compose up: runtime-manager then auth-gateway switch to node:22 + volume (~10 s)
#   5. each running user runtime is recreated on the new image with the volume mount, one at a time
# Untouched: ~/aidev/source, NPM, Portainer, certificates, networks, secrets, user volumes.
set -euo pipefail
payload=$(cd "${1:?payload dir}" && pwd)
DEPLOY="$HOME/aidev/deploy"
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

log "1/5 deploy tree -> $DEPLOY"
mkdir -p "$DEPLOY"; tar xzf "$payload/deploy.tgz" -C "$DEPLOY" --strip-components=1
chmod +x "$DEPLOY"/release/*.sh
if [ ! -f "$DEPLOY/.env" ]; then
  sed 's/^AIDEV_PROXY_NETWORK=.*/AIDEV_PROXY_NETWORK=npm_bridge/; s#^AIDEV_SECRET_DIR=.*#AIDEV_SECRET_DIR=/home/turtlelab/aidev/secrets#' "$DEPLOY/.env.example" > "$DEPLOY/.env"
  chmod 600 "$DEPLOY/.env"; echo "   wrote $DEPLOY/.env"
fi
set -a; . "$DEPLOY/.env"; set +a
[ -f "$AIDEV_SECRET_DIR/gateway-jwt" ] || { echo "secrets missing in $AIDEV_SECRET_DIR"; exit 1; }
docker network inspect "$AIDEV_PROXY_NETWORK" >/dev/null
docker ps --format '{{.Names}}' | grep -q '^aidev-auth-gateway$' || { echo "aidev stack not running"; exit 1; }

log "2/5 release -> aidev_app volume"
tgz=$(ls "$payload"/release-*.tgz | head -1)
sha=$("$DEPLOY/release/release.sh" install "$tgz" | tail -1)
"$DEPLOY/release/release.sh" activate "$sha"

log "3/5 tools-only runtime image"
"$DEPLOY/release/runtime-image.sh" build "tools-$(date +%Y%m%d)"

log "4/5 control plane -> node:22 + volume"
( cd "$DEPLOY" && docker compose -p aidev --env-file .env -f docker-compose.yml up -d runtime-manager auth-gateway 2>&1 | tail -6 )
for i in $(seq 1 40); do
  [ "$(docker inspect aidev-runtime-manager --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] \
  && docker run --rm --network npm_bridge curlimages/curl:8.16.0 -fsS -m 3 http://aidev-auth-gateway:8080/_gateway/health >/dev/null 2>&1 && break; sleep 2
done
docker run --rm --network npm_bridge curlimages/curl:8.16.0 -fsS -m 5 http://aidev-auth-gateway:8080/_gateway/release; echo

log "5/5 user runtimes -> new image + volume (one at a time)"
token_start() { docker exec aidev-runtime-manager node -e '
  const fs=require("node:fs"); const t=fs.readFileSync("/run/secrets/runtime-token","utf8").trim();
  fetch("http://127.0.0.1:8090/v1/runtimes/"+process.argv[1]+"/start",{method:"POST",headers:{"x-runtime-token":t}})
    .then(async r=>{ if(!r.ok) throw new Error(r.status+" "+await r.text()); console.log("   started",process.argv[1]); })
    .catch(e=>{ console.error(String(e)); process.exit(1); });' "$1"; }
docker ps -a --filter label=work.nado.aidev.managed=true --format '{{.Label "work.nado.aidev.runtime"}}\t{{.Names}}\t{{.State}}' \
| while IFS=$'\t' read -r name cname state; do
  [ -n "$name" ] || continue
  if docker inspect "$cname" --format '{{range .Mounts}}{{.Destination}} {{end}}' | grep -q '/srv/app'; then echo "   $cname already migrated"; continue; fi
  echo "   $cname ($state): recreate"
  docker rm -f "$cname" >/dev/null
  [ "$state" = running ] && token_start "$name" || echo "   $cname was $state; it is recreated on next login"
done

"$DEPLOY/release/release.sh" status
echo "DEPLOYED_RELEASE=$sha"
echo "note: old images aidev/cloudcli:dynamic, aidev/auth-gateway:phase1, aidev/runtime-manager:phase1 kept for rollback; remove later with docker rmi"
