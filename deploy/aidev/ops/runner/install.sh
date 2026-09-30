#!/bin/bash
# Mac: put the newest built runner (ops/runner/dist) in place and restart it — building (./runner/build.sh)
# only writes ops/runner/dist/; the runner that is connected keeps running its old binary until this replaces it.
#   ./runner/install.sh                 # newest version in ops/runner/dist
#   ./runner/install.sh 0.9.0           # a specific version
# The work is done by the repository's per-OS installer (deploy/aidev/runner/scripts/install-macos.sh).
set -euo pipefail
OPS=$(cd "$(dirname "$0")/.." && pwd)
REPO=${AIDEV_REPO:-$OPS/../aidev}
script="$REPO/deploy/aidev/runner/scripts/install-macos.sh"
[ -x "$script" ] || { echo "$script 없음 — ./push-source.sh 로 소스를 최신으로 만든 뒤 다시 실행하세요"; exit 1; }
exec "$script" --dist "$OPS/runner/dist" ${1:+--version "$1"}
