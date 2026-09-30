#!/usr/bin/env bash
# Stages what the gateway serves under /_runner/ into <out>: the built binaries and adapters (runner/dist),
# the per-OS install/build scripts (→ /_runner/scripts/…) and the runner source (→ /_runner/source/
# aidev-runner-src.tar.gz, for PCs whose OS/CPU has no binary). Used by release/pack.sh and the smoke test.
#   runner/scripts/stage-dist.sh <out>
set -euo pipefail
runner=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?usage: stage-dist.sh <out>}
mkdir -p "$out/scripts" "$out/source"
if [ -d "$runner/dist" ]; then cp -a "$runner/dist/." "$out/"; fi
cp "$runner"/scripts/install-*.sh "$runner"/scripts/build-*.sh "$runner"/scripts/*.ps1 "$out/scripts/"
tar --sort=name --mtime='2026-01-01 00:00Z' --owner=0 --group=0 --numeric-owner \
  --exclude='target' --exclude='dist' --exclude='*.class' \
  --transform 's,^\.,aidev-runner-src,' -C "$runner" -czf "$out/source/aidev-runner-src.tar.gz" \
  ./Cargo.toml ./Cargo.lock ./build.sh ./README.md ./src ./assets ./scripts
