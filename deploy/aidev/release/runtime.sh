#!/usr/bin/env bash
# Lane B — CloudCLI runtime image (server/ code, dependencies, entrypoint, tools).
#   runtime.sh build            build aidev/cloudcli:<sha> from the repo, retag as :dynamic
#   runtime.sh rollout          recreate managed runtimes one at a time on the current :dynamic image
#   runtime.sh rollback <sha>   retag :dynamic to an earlier build (then run rollout)
# The deps layer (npm ci + native rebuild) is cached; a source-only change rebuilds
# only tsc/vite. Rollout removes a runtime's container (volumes and networks stay),
# then asks runtime-manager to start it, which recreates it on the new image and
# waits for /health. Users on that runtime reconnect; their sessions live in volumes.
. "$(dirname "$0")/lib.sh"
load_env

case "${1:-}" in
  build)
    sha=$(git_sha)
    log "building aidev/cloudcli:$sha (Claude Code ${CLAUDE_CODE_VERSION:?})"
    DOCKER_BUILDKIT=1 docker build -f "$DEPLOY/cloudcli.Dockerfile" "$REPO" \
      --build-arg CLAUDE_CODE_VERSION="$CLAUDE_CODE_VERSION" \
      --build-arg SDB_TARBALL_URL="${SDB_TARBALL_URL:-}" --build-arg SDB_SHA256="${SDB_SHA256:-}" \
      --build-arg AIDEV_RELEASE="$sha" -t "aidev/cloudcli:$sha" 2>&1 | tail -25
    docker tag "aidev/cloudcli:$sha" aidev/cloudcli:dynamic
    echo "$sha" > "$STATE_DIR/cloudcli.current"
    ok "aidev/cloudcli:dynamic -> $sha" ;;
  rollback)
    [ -n "${2:-}" ] || fail "usage: runtime.sh rollback <sha>"
    docker image inspect "aidev/cloudcli:$2" >/dev/null || fail "no image aidev/cloudcli:$2"
    docker tag "aidev/cloudcli:$2" aidev/cloudcli:dynamic; echo "$2" > "$STATE_DIR/cloudcli.current"
    ok "aidev/cloudcli:dynamic -> $2 (run: runtime.sh rollout)" ;;
  rollout)
    want=$(docker image inspect aidev/cloudcli:dynamic --format '{{.Id}}')
    managed_runtimes | while IFS=$'\t' read -r name cname state image; do
      [ -n "$name" ] || continue
      have=$(docker inspect "$cname" --format '{{.Image}}')
      if [ "$have" = "$want" ]; then ok "$cname already on current image"; continue; fi
      if [ "$state" != "running" ]; then
        log "$cname is $state; removing so the next login recreates it on the new image"
        docker rm -f "$cname" >/dev/null; continue
      fi
      log "rolling $cname"
      docker rm -f "$cname" >/dev/null
      runtime_start "$name" || fail "runtime-manager could not restart $name — check: docker logs aidev-runtime-manager"
      ok "$cname recreated and healthy"
    done ;;
  *) fail "usage: runtime.sh build | rollout | rollback <sha>" ;;
esac
