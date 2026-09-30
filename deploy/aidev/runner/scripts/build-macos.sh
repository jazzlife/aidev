#!/bin/bash
# macOS: build aidev-runner natively on this Mac — arm64 + x86_64 and a universal binary — into
# ../dist/aidev-runner-<version>-mac-{arm64,x64,universal} (+ SHA256SUMS).
#   scripts/build-macos.sh                     # build
#   scripts/build-macos.sh --install [--code <pairing code>] [--gateway URL]   # … then install it (install-macos.sh)
#   scripts/build-macos.sh --check             # only check the toolchain
#   scripts/build-macos.sh --cross             # also Windows x64 / Linux arm64·armv7 (zig + cargo-zigbuild)
# Needs: Xcode command line tools (clang, lipo, codesign), Rust from https://rustup.rs. nasm (brew install nasm)
# gives the Intel slice's H.264 encoder its SIMD code; Apple Silicon needs none.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); src=$(cd "$here/.." && pwd)
install=0; check=0; cross=0; pass=()
while [ $# -gt 0 ]; do
  case $1 in
    --install) install=1 ;; --check) check=1 ;; --cross) cross=1 ;;
    --code|--gateway|--name) pass+=("$1" "${2:?$1 needs a value}"); shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Darwin ] || { echo "macOS 전용입니다 (Linux: scripts/build-linux.sh, Windows: scripts\\build-windows.ps1)"; exit 1; }
missing=()
xcode-select -p >/dev/null 2>&1 || missing+=("Xcode 명령행 도구: xcode-select --install")
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
command -v rustup >/dev/null || missing+=("Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y")
command -v nasm >/dev/null || echo "참고: nasm이 없으면 Intel 슬라이스의 H.264 인코딩이 느립니다 (brew install nasm)"
if [ ${#missing[@]} -gt 0 ]; then echo "빌드에 필요한 것이 없습니다:"; printf '  - %s\n' "${missing[@]}"; exit 1; fi
need=$(sed -n 's/^rust-version = "\(.*\)"/\1/p' "$src/Cargo.toml" | head -1)
have=$(rustc --version | awk '{print $2}')
if [ -n "$need" ] && [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
  echo "==> Rust $have < $need: rustup update stable"; [ $check = 1 ] || rustup update stable
fi
[ $check = 1 ] && { echo "도구 준비됨: $(rustc --version), $(clang --version | head -1)"; exit 0; }
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
groups=(mac)
if [ $cross = 1 ]; then
  rustup target add x86_64-pc-windows-gnu aarch64-unknown-linux-gnu armv7-unknown-linux-gnueabihf >/dev/null
  groups+=(win-x64 linux-arm64 linux-armv7)
fi
cd "$src" && ./build.sh "${groups[@]}"
if [ $install = 1 ]; then exec "$here/install-macos.sh" --dist "$src/dist" "${pass[@]}"; fi
echo "설치: scripts/install-macos.sh --dist $src/dist [--code <페어링 코드>]"
