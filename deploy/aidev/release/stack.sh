#!/usr/bin/env bash
# Lane C — gateway / runtime-manager (the Portainer stack `aidev`).
#   stack.sh gateway          build aidev/auth-gateway:<sha> and replace the container (~5s gap)
#   stack.sh runtime-manager  build aidev/runtime-manager:<sha> and replace the container
#   stack.sh status
# Uses the same compose file and project name as the Portainer stack, so Portainer
# keeps showing and managing it. Image tags move to <sha>; the previous tag is kept
# for rollback (edit .env AIDEV_*_TAG and re-run).
. "$(dirname "$0")/lib.sh"
load_env
sha=$(git_sha)

case "${1:-}" in
  gateway)
    log "building aidev/auth-gateway:$sha"
    AIDEV_GATEWAY_TAG="$sha" compose build auth-gateway 2>&1 | tail -8
    log "replacing aidev-auth-gateway"
    AIDEV_GATEWAY_TAG="$sha" compose up -d --no-deps --no-build auth-gateway 2>&1 | tail -3
    for i in $(seq 1 30); do gateway_health 2>/dev/null && break; sleep 1; done
    gateway_health || fail "gateway unhealthy after replace — rollback: AIDEV_GATEWAY_TAG=<old> stack.sh gateway"
    sed -i "s/^AIDEV_GATEWAY_TAG=.*/AIDEV_GATEWAY_TAG=$sha/" "$ENV_FILE"; grep -q '^AIDEV_GATEWAY_TAG=' "$ENV_FILE" || echo "AIDEV_GATEWAY_TAG=$sha" >> "$ENV_FILE"
    ok "gateway on $sha: $(gateway_release)" ;;
  runtime-manager)
    log "building aidev/runtime-manager:$sha"
    AIDEV_RUNTIME_MANAGER_TAG="$sha" compose build runtime-manager 2>&1 | tail -8
    AIDEV_RUNTIME_MANAGER_TAG="$sha" compose up -d --no-deps --no-build runtime-manager 2>&1 | tail -3
    for i in $(seq 1 40); do [ "$(docker inspect aidev-runtime-manager --format '{{.State.Health.Status}}')" = healthy ] && break; sleep 1; done
    [ "$(docker inspect aidev-runtime-manager --format '{{.State.Health.Status}}')" = healthy ] || fail "runtime-manager unhealthy"
    sed -i "s/^AIDEV_RUNTIME_MANAGER_TAG=.*/AIDEV_RUNTIME_MANAGER_TAG=$sha/" "$ENV_FILE"; grep -q '^AIDEV_RUNTIME_MANAGER_TAG=' "$ENV_FILE" || echo "AIDEV_RUNTIME_MANAGER_TAG=$sha" >> "$ENV_FILE"
    ok "runtime-manager on $sha" ;;
  status)
    echo "repo: $(git -C "$REPO" log --oneline -1)"; echo "deployed tag: $(git -C "$REPO" describe --tags --match 'deployed/*' --abbrev=0 2>/dev/null || echo none)"
    echo "frontend: $(gateway_release 2>/dev/null || echo unreachable)"
    echo "cloudcli:dynamic -> $(cat "$STATE_DIR/cloudcli.current" 2>/dev/null || echo '?')"
    compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}'
    echo "--- managed runtimes"; managed_runtimes ;;
  *) fail "usage: stack.sh gateway | runtime-manager | status" ;;
esac
