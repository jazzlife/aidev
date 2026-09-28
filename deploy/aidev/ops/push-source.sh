#!/bin/bash
# Mac: publish the newest checkpoint bundle (ops/backups/aidev-ckpt_*.bundle) to GitHub jazzlife/aidev.
# The cloud workspace cannot push (not an authorized repository for the session), so each stage's
# bundle is fast-forwarded into ../aidev (a clone with origin = jazzlife/aidev) and pushed from here,
# with the Mac's own GitHub credentials.   Usage: ./push-source.sh [bundle]
set -euo pipefail
OPS=$(cd "$(dirname "$0")" && pwd)
REPO=${AIDEV_REPO:-$OPS/../aidev}
bundle=${1:-$(ls -t "$OPS"/backups/aidev-ckpt_*.bundle | head -1)}
[ -f "$bundle" ] || { echo "no bundle found in $OPS/backups" >&2; exit 1; }
[ -d "$REPO/.git" ] || { echo "no clone at $REPO (git clone <bundle> $REPO; git -C $REPO remote set-url origin https://github.com/jazzlife/aidev.git)" >&2; exit 1; }
cd "$REPO"
git diff --quiet && git diff --cached --quiet || { echo "$REPO has local changes; commit or stash them first" >&2; exit 1; }
echo "== bundle: $(basename "$bundle")"
git fetch -q "$bundle" main:refs/remotes/bundle/main 'refs/tags/ckpt/*:refs/tags/ckpt/*'
git checkout -q main
git merge -q --ff-only refs/remotes/bundle/main
echo "== main at $(git log -1 --format='%h %s')"
git push origin main 'refs/tags/ckpt/*'
echo "== pushed: https://github.com/jazzlife/aidev (main + checkpoint tags)"
