#!/usr/bin/env bash
# Entry point for every partial update. Called by the relay's apply.sh from a payload dir:
#   deploy.sh <payload-dir>
# payload-dir contains:
#   commits.bundle   git bundle of <deployed>..<new> on branch main   (optional if only dist)
#   dist.tgz         Vite build of the new commit, made in the cloud workspace (optional)
#   lanes            optional override: space-separated subset of "frontend runtime gateway runtime-manager"
# Lanes are chosen from the paths that changed since the `deployed/current` tag:
#   src/ public/ index.html vite.* tailwind.* postcss.*    -> frontend  (needs dist.tgz)
#   server/ shared/ package*.json deploy/aidev/cloudcli*   -> runtime   (image build + rolling recreate)
#   deploy/aidev/auth-gateway/                             -> gateway
#   deploy/aidev/runtime-manager/                          -> runtime-manager
#   deploy/aidev/docker-compose.yml                        -> gateway + runtime-manager
. "$(dirname "$0")/lib.sh"
payload="${1:?payload dir}"; payload=$(cd "$payload" && pwd)
cd "$REPO"

before=$(git rev-parse HEAD)
if [ -f "$payload/commits.bundle" ]; then
  log "fetching commits"
  git bundle verify "$payload/commits.bundle" >/dev/null || fail "bundle does not apply to this repo (base mismatch)"
  git fetch -q "$payload/commits.bundle" main
  git merge -q --ff-only FETCH_HEAD || fail "server repo is not an ancestor of the payload (someone committed on the server?)"
fi
after=$(git rev-parse HEAD); sha=$(git_sha)
deployed=$(git rev-parse -q --verify deployed/current 2>/dev/null || echo "")
log "deploying $sha (deployed: ${deployed:0:12})"

if [ -f "$payload/lanes" ]; then
  lanes=$(cat "$payload/lanes")
else
  lanes=""
  paths=$(changed_paths "$deployed" "$after")
  echo "$paths" | grep -qE '^(src/|public/|index\.html$|vite\.config|tailwind\.config|postcss\.config)' && lanes="$lanes frontend"
  echo "$paths" | grep -qE '^(server/|shared/|package(-lock)?\.json$|deploy/aidev/cloudcli)' && lanes="$lanes runtime"
  echo "$paths" | grep -qE '^deploy/aidev/(auth-gateway/|docker-compose\.yml)' && lanes="$lanes gateway"
  echo "$paths" | grep -qE '^deploy/aidev/(runtime-manager/|docker-compose\.yml)' && lanes="$lanes runtime-manager"
fi
[ -n "$lanes" ] || { ok "nothing to deploy for $sha"; git tag -f deployed/current >/dev/null; exit 0; }
log "lanes:$lanes"

for lane in $lanes; do
  case $lane in
    runtime-manager) "$DEPLOY/release/stack.sh" runtime-manager ;;
    gateway)         "$DEPLOY/release/stack.sh" gateway ;;
    frontend)
      [ -f "$payload/dist.tgz" ] || fail "frontend lane needs dist.tgz in the payload"
      "$DEPLOY/release/frontend.sh" "$payload/dist.tgz" "$sha" ;;
    runtime)         "$DEPLOY/release/runtime.sh" build && "$DEPLOY/release/runtime.sh" rollout ;;
    *) fail "unknown lane $lane" ;;
  esac
done

git tag -f deployed/current >/dev/null; git tag -f "deployed/$(date +%Y%m%d-%H%M%S)-$sha" >/dev/null
gateway_health && ok "deployed $sha  ($(gateway_release))"
echo "DEPLOYED_SHA=$(git rev-parse HEAD)"
