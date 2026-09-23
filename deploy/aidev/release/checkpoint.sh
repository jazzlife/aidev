#!/usr/bin/env bash
# Backup point for a finished checklist item (IMPLEMENTATION-PLAN §4), run in the build workspace:
#   checkpoint.sh B-06 "gateway routing APIs"  [out-dir]
# 1. annotated tag ckpt/<ID>-<yyyymmdd>[-n]   2. git bundle (full history) -> <out-dir>/aidev-<tag>.bundle
# 3. push main + tag to origin when a remote is reachable (skipped, not failed, otherwise)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); cd "$ROOT"
id=${1:?checklist id}; msg=${2:-checkpoint}; out=${3:-/mnt/user-data/outputs/backups}
git diff --quiet HEAD || { echo "working tree dirty; commit first" >&2; exit 1; }
base="ckpt/${id}-$(date -u +%Y%m%d)"; tag=$base; n=1
while git rev-parse -q --verify "refs/tags/$tag" >/dev/null; do n=$((n+1)); tag="$base-$n"; done
git tag -a "$tag" -m "$id: $msg"
mkdir -p "$out"
bundle="$out/aidev-$(echo "$tag" | tr '/' '_').bundle"
git bundle create "$bundle" --all >/dev/null 2>&1
git bundle verify "$bundle" >/dev/null 2>&1 && echo "bundle: $bundle ($(du -h "$bundle" | cut -f1))"
if git remote get-url origin >/dev/null 2>&1; then
  if git push origin main "$tag" >/dev/null 2>&1; then echo "pushed: origin main + $tag"; else echo "push skipped: origin not reachable/authorized (tag kept locally: $tag)"; fi
fi
echo "tag: $tag"
