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
mkdir -p dist
have_std() { rustup target list --installed 2>/dev/null | grep -qx "$1"; }
zig_ok() { command -v zig >/dev/null && cargo zigbuild --version >/dev/null 2>&1; }
built=()
build() {   # label rust-target [zig-suffix]
  local label=$1 target=$2 suffix=${3:-} ext=""; [[ $target == *windows* ]] && ext=.exe
  if ! have_std "$target"; then echo "skip $label: rustup target add $target"; return; fi
  if [[ $target == *apple* ]]; then cargo build --release --target "$target"
  elif zig_ok; then cargo zigbuild --release --target "$target$suffix"
  elif [ "$target" = "$(rustc -vV | sed -n 's/host: //p')" ]; then cargo build --release --target "$target"
  else echo "skip $label: needs zig + cargo-zigbuild for cross-linking"; return; fi
  cp "target/$target/release/aidev-runner$ext" "dist/aidev-runner-$ver-$label$ext"; built+=("aidev-runner-$ver-$label$ext")
}
want=${*:-linux-x64 linux-arm64 win-x64 mac}
for w in $want; do
  case $w in
    linux-x64)   build linux-x64 x86_64-unknown-linux-gnu .2.28 ;;
    linux-arm64) build linux-arm64 aarch64-unknown-linux-gnu .2.28 ;;
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
(cd dist && { command -v sha256sum >/dev/null && sha256sum "${built[@]}" || shasum -a 256 "${built[@]}"; } >> SHA256SUMS && sort -u -k2 SHA256SUMS -o SHA256SUMS)
ls -la dist
