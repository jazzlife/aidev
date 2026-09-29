#!/bin/bash
# Mac: build aidev-runner for macOS (universal arm64+x86_64) and, when the toolchains are present,
# Windows x64 / Linux arm64 — then copy the binaries to ops/runner/dist/.
#   ./runner/build.sh                 # mac + win-x64 + linux-arm64 (skips what is not installed)
#   ./runner/build.sh mac             # macOS only
# Needs the source in ../aidev (run ./push-source.sh first so it is current) and Rust (https://rustup.rs).
# Windows/Linux cross builds also need:  brew install zig nasm && cargo install cargo-zigbuild
#                                         rustup target add x86_64-pc-windows-gnu aarch64-unknown-linux-gnu
# The runner has H.264 built in (OpenH264, compiled from source — a C++ compiler comes with Xcode's command
# line tools). nasm gives it SIMD on x86 (Windows, the Intel Mac slice); Apple Silicon uses NEON without it.
set -euo pipefail
OPS=$(cd "$(dirname "$0")/.." && pwd)
REPO=${AIDEV_REPO:-$OPS/../aidev}
SRC="$REPO/deploy/aidev/runner"
command -v cargo >/dev/null || { echo "Rust가 필요합니다: https://rustup.rs"; exit 1; }
[ -f "$SRC/Cargo.toml" ] || { echo "$SRC 없음 — ./push-source.sh 로 소스를 최신으로 만든 뒤 다시 실행하세요"; exit 1; }
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
cd "$SRC" && ./build.sh ${*:-mac win-x64 linux-arm64}
mkdir -p "$OPS/runner/dist" && cp dist/* "$OPS/runner/dist/"
echo "==> $OPS/runner/dist"; ls -la "$OPS/runner/dist"
