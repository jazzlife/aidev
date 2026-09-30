#!/bin/bash
# Mac: publish the newest checkpoint bundle (ops/backups/aidev-ckpt_*.bundle) to GitHub jazzlife/aidev.
# The cloud workspace cannot push (not an authorized repository for the session), so each stage's
# bundle is fast-forwarded into ../aidev (a clone with origin = jazzlife/aidev) and pushed from here,
# with the Mac's own GitHub credentials.   Usage: ./push-source.sh [bundle]
# Normally not run by hand: Claude queues `push [backups/<bundle>]` for `./relay.sh watch`.
#   main + ckpt/* tags: fast-forward only.
#   runner-v* tags in the bundle (they start .github/workflows/runner-release.yml): pushed after main; a tag
#   that already exists on GitHub is moved to the bundle's commit only while no GitHub release was published
#   for it (a failed CI run before publishing) — a published release is never re-pointed.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0   # from the watcher nobody can answer a credential prompt: fail instead of hanging
OPS=$(cd "$(dirname "$0")" && pwd)
REPO=${AIDEV_REPO:-$OPS/../aidev}
GH_REPO=jazzlife/aidev
bundle=${1:-$(ls -t "$OPS"/backups/aidev-ckpt_*.bundle | head -1)}
case $bundle in /*) ;; *) [ -f "$bundle" ] || bundle="$OPS/$bundle" ;; esac
[ -f "$bundle" ] || { echo "no bundle found: $bundle" >&2; exit 1; }
[ -d "$REPO/.git" ] || { echo "no clone at $REPO (git clone <bundle> $REPO; git -C $REPO remote set-url origin https://github.com/$GH_REPO.git)" >&2; exit 1; }
cd "$REPO"
git diff --quiet && git diff --cached --quiet || { echo "$REPO has local changes; commit or stash them first" >&2; exit 1; }
echo "== bundle: $(basename "$bundle")"
git bundle verify -q "$bundle" >/dev/null
git fetch -q "$bundle" main:refs/remotes/bundle/main 'refs/tags/ckpt/*:refs/tags/ckpt/*'
git checkout -q main
git merge -q --ff-only refs/remotes/bundle/main
echo "== main at $(git log -1 --format='%h %s')"
git push origin main 'refs/tags/ckpt/*'
echo "== pushed: https://github.com/$GH_REPO (main + checkpoint tags)"

# ---- runner release tags ------------------------------------------------------------------------------
for tag in $(git bundle list-heads "$bundle" | sed -n 's#^[0-9a-f]* refs/tags/\(runner-v[0-9][0-9A-Za-z.-]*\)$#\1#p'); do
  git fetch -q "$bundle" "refs/tags/$tag"; want=$(git rev-parse 'FETCH_HEAD^{commit}')
  # the commit the tag on GitHub points to (the peeled "^{}" line for an annotated tag)
  rem=$(git ls-remote origin "refs/tags/$tag")
  have=$(printf '%s\n' "$rem" | awk -v p="refs/tags/$tag^{}" '$2 == p { print $1 }')
  [ -n "$have" ] || have=$(printf '%s\n' "$rem" | awk -v p="refs/tags/$tag" '$2 == p { print $1 }')
  if [ "$have" = "$want" ]; then
    echo "== $tag already at ${want:0:8}"; continue
  fi
  if [ -n "$have" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' "https://api.github.com/repos/$GH_REPO/releases/tags/$tag" || echo 000)
    [ "$code" = 404 ] || { echo "!! $tag: GitHub release exists (HTTP $code) — not moving a published tag; bump the version instead" >&2; exit 1; }
    echo "== $tag: moving to ${want:0:8} (no release was published for it)"
  else
    echo "== $tag: new at ${want:0:8}"
  fi
  git tag -f "$tag" "$want" >/dev/null
  git push -f origin "refs/tags/$tag"
  echo "== pushed $tag → Actions: https://github.com/$GH_REPO/actions/workflows/runner-release.yml"
done
