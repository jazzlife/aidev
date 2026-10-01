#!/bin/bash
# Mac: build aidev-runner for macOS (universal arm64+x86_64) and, when the toolchains are present,
# Windows x64 / Linux arm64 / Linux armv7 (SBCs) — then copy the binaries to ops/runner/dist/.
#   ./runner/build.sh                 # mac + win-x64 + linux-arm64 + linux-armv7 (skips what is not installed)
#   ./runner/build.sh mac             # macOS only
# Needs the source in ../aidev (run ./push-source.sh first so it is current) and Rust (https://rustup.rs).
# Windows/Linux cross builds also need:  brew install zig nasm && cargo install cargo-zigbuild
#                                         rustup target add x86_64-pc-windows-gnu aarch64-unknown-linux-gnu armv7-unknown-linux-gnueabihf
# The runner has H.264 built in (OpenH264, compiled from source — a C++ compiler comes with Xcode's command
# line tools). nasm gives it SIMD on x86 (Windows, the Intel Mac slice); Apple Silicon uses NEON without it.
set -euo pipefail
OPS=$(cd "$(dirname "$0")/.." && pwd)
REPO=${AIDEV_REPO:-$OPS/../aidev}
SRC="$REPO/deploy/aidev/runner"
command -v cargo >/dev/null || { echo "Rust가 필요합니다: https://rustup.rs"; exit 1; }
[ -f "$SRC/Cargo.toml" ] || { echo "$SRC 없음 — ./push-source.sh 로 소스를 최신으로 만든 뒤 다시 실행하세요"; exit 1; }
# the runner declares its minimum Rust (Cargo.toml rust-version): update the stable toolchain when older
need=$(sed -n 's/^rust-version = "\(.*\)"/\1/p' "$SRC/Cargo.toml" | head -1)
have=$(rustc --version | awk '{print $2}')
if [ -n "$need" ] && [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
  echo "==> Rust $have < $need: rustup update stable"
  rustup update stable
fi
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
cd "$SRC" && ./build.sh ${*:-mac win-x64 linux-arm64 linux-armv7}
mkdir -p "$OPS/runner/dist" && cp -R dist/. "$OPS/runner/dist/"   # binaries and adapters/
echo "==> $OPS/runner/dist"; ls -la "$OPS/runner/dist"
# this Mac is also a runner host: put the new build in place right away (skip: AIDEV_NO_INSTALL=1)
if [ "$(uname -s)" = Darwin ] && [ -z "${AIDEV_NO_INSTALL:-}" ] && ls "$OPS/runner/dist/" | grep -q -- "-mac-"; then
  echo "==> 이 Mac의 러너 교체"; "$OPS/runner/install.sh"
else
  echo "==> 실행 중인 러너 교체: ./runner/install.sh  (빌드만으로는 연결된 러너가 바뀌지 않습니다)"
fi
