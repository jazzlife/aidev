#!/usr/bin/env bash
# Static libvpx — the VP9 encoder only — for the runner's `vpx` feature (F-18): vendor/libvpx/<rust target>/{lib,include}.
#   scripts/build-libvpx.sh [rust-target]      default: this machine's
# Linux targets build through zig against glibc 2.28, like the runner itself (build.sh: zig on PATH or the `ziglang`
# pip package); macOS with the Xcode tools. x86_64 needs nasm. Windows: scripts\build-libvpx.ps1.
# The version is pinned: src/vpx_ffi.rs (bindgen) is generated from its headers.
set -euo pipefail
VERSION=v1.17.0
here=$(cd "$(dirname "$0")/.." && pwd)
target=${1:-$(rustc -vV | sed -n 's/host: //p')}
out=$here/vendor/libvpx/$target
if [ -f "$out/lib/libvpx.a" ] && [ "$(cat "$out/VERSION" 2>/dev/null)" = "$VERSION" ]; then
  echo "libvpx $VERSION ($target): $out"; exit 0
fi
src=$here/vendor/libvpx/src-$VERSION
[ -d "$src" ] || git clone -q --depth 1 --branch "$VERSION" https://chromium.googlesource.com/webm/libvpx "$src"

zt=""; extra=""
case $target in
  x86_64-unknown-linux-gnu)       vt=x86_64-linux-gcc;   zt=x86_64-linux-gnu.2.28 ;;
  aarch64-unknown-linux-gnu)      vt=arm64-linux-gcc;    zt=aarch64-linux-gnu.2.28 ;;
  armv7-unknown-linux-gnueabihf)  vt=armv7-linux-gcc;    zt=arm-linux-gnueabihf.2.28 ;;
  aarch64-apple-darwin)           vt=arm64-darwin23-gcc ;;
  x86_64-apple-darwin)            vt=x86_64-darwin23-gcc ;;
  *) echo "build-libvpx.sh: $target 은(는) 지원하지 않습니다" >&2; exit 1 ;;
esac

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
if [ -n "$zt" ]; then
  # zig as the C compiler: one wrapper per tool, so configure sees plain commands
  if command -v zig >/dev/null; then zig="zig"; else zig="python3 -m ziglang"; fi
  mkdir -p "$work/bin"
  printf '#!/bin/sh\nexec %s cc -target %s "$@"\n' "$zig" "$zt" > "$work/bin/zcc"
  printf '#!/bin/sh\nexec %s c++ -target %s "$@"\n' "$zig" "$zt" > "$work/bin/zcxx"
  printf '#!/bin/sh\nexec %s ar "$@"\n' "$zig" > "$work/bin/zar"
  printf '#!/bin/sh\nexec %s ranlib "$@"\n' "$zig" > "$work/bin/zranlib"
  chmod +x "$work/bin/"*
  export CC="$work/bin/zcc" CXX="$work/bin/zcxx" AR="$work/bin/zar" LD="$work/bin/zcc" RANLIB="$work/bin/zranlib"
  # Arm assembly (.S) goes through the C compiler as well; ARMv7's hand-written NEON .asm is GNU-as only (clang
  # rejects its -mcpu=armv7): the same NEON code as C intrinsics instead
  case $vt in arm*) export AS="$work/bin/zcc" ;; esac
  case $vt in armv7*) extra="--disable-neon-asm" ;; esac
fi
mkdir -p "$work/build" && cd "$work/build"
"$src/configure" --target="$vt" --prefix="$out" \
  --enable-static --disable-shared --enable-pic \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-webm-io --disable-libyuv \
  --disable-vp8 --enable-vp9 --disable-vp9-decoder --enable-vp9-encoder --enable-realtime-only \
  --enable-runtime-cpu-detect $extra > configure.log 2>&1 || { tail -30 configure.log; exit 1; }
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" > make.log 2>&1 || { tail -40 make.log; exit 1; }
make install > /dev/null
echo "$VERSION" > "$out/VERSION"
echo "libvpx $VERSION ($target): $out"
