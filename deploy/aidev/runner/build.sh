#!/usr/bin/env bash
# Release builds of aidev-runner → dist/aidev-runner-<version>-<target>[.exe] + SHA256SUMS.
#   build.sh                 # every target whose Rust std is installed (rustup target add …)
#   build.sh linux-x64 win-x64 mac   # a subset
# Linux builds link against glibc 2.28 through zig (cargo-zigbuild) so they run on older distros;
# Windows (x86_64-pc-windows-gnu) also goes through zig. macOS targets need a Mac (Apple SDK):
# run this script there (ops/runner/build.sh wraps it) — `mac` makes a universal arm64+x86_64 binary.
set -euo pipefail
cd "$(dirname "$0")"
ver=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
need=$(sed -n 's/^rust-version = "\(.*\)"/\1/p' Cargo.toml | head -1)
have=$(rustc --version | awk '{print $2}')
if [ -n "$need" ] && [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
  echo "error: Rust $have is too old — this runner needs $need or newer (rustup update stable)"; exit 1
fi
mkdir -p dist
have_std() { rustup target list --installed 2>/dev/null | grep -qx "$1"; }
# zig on PATH or the `ziglang` pip package (cargo-zigbuild finds either); `cargo zigbuild --version` is not a flag
zig_ok() { { command -v zig >/dev/null || python3 -m ziglang version >/dev/null 2>&1; } && cargo zigbuild --help >/dev/null 2>&1; }
built=()
build() {   # label rust-target [zig-suffix]
  local label=$1 target=$2 suffix=${3:-} ext=""; [[ $target == *windows* ]] && ext=.exe
  if ! have_std "$target"; then echo "skip $label: rustup target add $target"; return; fi
  # OpenH264 (built in) silently drops its SIMD assembly without nasm on x86 — 3x slower encoding
  # (Apple Silicon uses NEON through clang, no nasm needed; the Intel slice of the mac build only warns)
  if [[ $target == x86_64* ]] && ! command -v nasm >/dev/null; then
    if [[ $target == *apple* ]]; then echo "warning $label: no nasm — the Intel Mac slice encodes without SIMD (brew install nasm)"
    else echo "error $label: nasm is required for x86 builds (apt install nasm)"; exit 1; fi
  fi
  # Linux: VP9 through a static libvpx (F-18 — the remote screen's software encoder; AIDEV_VP9=0 leaves it out)
  local features=()
  if [[ $target == *linux* && ${AIDEV_VP9:-1} != 0 ]]; then scripts/build-libvpx.sh "$target"; features=(--features vpx); fi
  if [[ $target == *apple* ]]; then cargo build --release --target "$target"
  elif zig_ok; then cargo zigbuild --release --target "$target$suffix" "${features[@]}"
  elif [ "$target" = "$(rustc -vV | sed -n 's/host: //p')" ]; then cargo build --release --target "$target" "${features[@]}"
  else echo "skip $label: needs zig + cargo-zigbuild for cross-linking"; return; fi
  cp "target/$target/release/aidev-runner$ext" "dist/aidev-runner-$ver-$label$ext"; built+=("aidev-runner-$ver-$label$ext")
}
want=${*:-linux-x64 linux-arm64 linux-armv7 win-x64 mac}
for w in $want; do
  case $w in
    linux-x64)   build linux-x64 x86_64-unknown-linux-gnu .2.28 ;;
    linux-arm64) build linux-arm64 aarch64-unknown-linux-gnu .2.28 ;;
    linux-armv7) build linux-armv7 armv7-unknown-linux-gnueabihf .2.28 ;;   # 32-bit Raspberry Pi OS and other ARMv7 SBCs
    win-x64)     build win-x64 x86_64-pc-windows-gnu ;;
    mac)
      if [ "$(uname -s)" != Darwin ]; then echo "skip mac: build on a Mac"; continue; fi
      build mac-arm64 aarch64-apple-darwin; build mac-x64 x86_64-apple-darwin
      if [ -f "dist/aidev-runner-$ver-mac-arm64" ] && [ -f "dist/aidev-runner-$ver-mac-x64" ]; then
        lipo -create -output "dist/aidev-runner-$ver-mac-universal" "dist/aidev-runner-$ver-mac-arm64" "dist/aidev-runner-$ver-mac-x64"; built+=("aidev-runner-$ver-mac-universal")
      fi ;;
    *) echo "unknown target group $w"; exit 1 ;;
  esac
done
[ ${#built[@]} -gt 0 ] || { echo "nothing built"; exit 1; }
# a rebuilt file replaces its old line (sort -u would keep either one)
(cd dist && {
  [ -f SHA256SUMS ] && grep -v -F -f <(printf '  %s\n' "${built[@]}") SHA256SUMS || true
  command -v sha256sum >/dev/null && sha256sum "${built[@]}" || shasum -a 256 "${built[@]}"
} | sort -k2 > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS)
ls -la dist
