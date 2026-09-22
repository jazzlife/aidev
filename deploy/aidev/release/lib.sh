#!/usr/bin/env bash
# Shared helpers for deploy/aidev/release/*.sh — sourced, not executed.
# Runs on the AI-PC as the docker-group user. Never needs sudo.
set -euo pipefail

REPO="${AIDEV_REPO:-$HOME/aidev/repo}"
DEPLOY="$REPO/deploy/aidev"
ENV_FILE="$DEPLOY/.env"
PROJECT=aidev
FRONTEND_VOLUME="${PROJECT}_frontend"
STATE_DIR="$HOME/aidev/state"
mkdir -p "$STATE_DIR"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓ \033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m ✗ \033[0m %s\n' "$*" >&2; exit 1; }

load_env() {
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE missing (copy .env.example)"
  set -a; # shellcheck disable=SC1090
  . "$ENV_FILE"; set +a
}

compose() { (cd "$DEPLOY" && docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.yml "$@"); }

git_sha() { git -C "$REPO" rev-parse --short=12 HEAD; }

# Files changed between two refs, or everything if $1 is empty.
changed_paths() {
  if [ -z "${1:-}" ]; then git -C "$REPO" ls-files; else git -C "$REPO" diff --name-only "$1" "${2:-HEAD}"; fi
}

# Health of the public path, from inside the proxy network.
gateway_health() {
  docker run --rm --network npm_bridge curlimages/curl:8.16.0 -fsS -m 5 http://aidev-auth-gateway:8080/_gateway/health >/dev/null
}
gateway_release() {
  docker run --rm --network npm_bridge curlimages/curl:8.16.0 -fsS -m 5 http://aidev-auth-gateway:8080/_gateway/release
}

managed_runtimes() {
  docker ps -a --filter label=work.nado.aidev.managed=true --format '{{.Label "work.nado.aidev.runtime"}}\t{{.Names}}\t{{.State}}\t{{.Image}}'
}

# Ask runtime-manager (only it holds the Docker socket) to (re)start one runtime.
runtime_start() {
  local name="$1"
  docker exec aidev-runtime-manager node -e '
    const fs=require("node:fs"); const t=fs.readFileSync("/run/secrets/runtime-token","utf8").trim();
    fetch("http://127.0.0.1:8090/v1/runtimes/"+process.argv[1]+"/start",{method:"POST",headers:{"x-runtime-token":t}})
      .then(async r=>{ const b=await r.text(); if(!r.ok) throw new Error(r.status+" "+b); console.log("started", process.argv[1]); })
      .catch(e=>{ console.error(String(e)); process.exit(1); });' "$name"
}
