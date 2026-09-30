#!/usr/bin/env bash
# Linux: build aidev-runner natively on this machine — desktop (x86_64), server, or an SBC (Raspberry Pi and
# other ARM boards: aarch64 / armv7) — into ../dist/aidev-runner-<version>-linux-<arch> (+ SHA256SUMS).
#   scripts/build-linux.sh                     # build for this machine
#   scripts/build-linux.sh --install [--code <pairing code>] [--gateway URL] [--name NAME]
#                                              # … then install and start it (scripts/install-linux.sh)
#   scripts/build-linux.sh --check             # only check the toolchain and say what to install
# Needs: Rust ≥ Cargo.toml rust-version (https://rustup.rs), a C and C++ compiler (the built-in H.264
# encoder, OpenH264, is compiled from source), and on x86_64 nasm (its SIMD code). Nothing else is linked
# against system libraries (X11 is spoken over its socket, TLS is rustls).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); src=$(cd "$here/.." && pwd)
install=0; check=0; pass=()
while [ $# -gt 0 ]; do
  case $1 in
    --install) install=1 ;;
    --check) check=1 ;;
    --code|--gateway|--name) pass+=("$1" "${2:?$1 needs a value}"); shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Linux ] || { echo "Linux 전용입니다 (macOS: scripts/build-macos.sh, Windows: scripts\\build-windows.ps1)"; exit 1; }
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  armv7l|armv7|armhf) arch=armv7 ;;
  *) echo "지원하지 않는 CPU: $(uname -m) (x86_64, aarch64, armv7)"; exit 1 ;;
esac

# ---- toolchain -----------------------------------------------------------------------------------------
missing=()
pm=""
for m in apt-get:apt dnf:dnf pacman:pacman apk:apk; do command -v "${m%%:*}" >/dev/null && { pm=${m##*:}; break; }; done
hint() {   # package names per package manager
  case $pm in
    apt) echo "sudo apt-get install -y $1" ;; dnf) echo "sudo dnf install -y $2" ;; pacman) echo "sudo pacman -S --needed $3" ;; apk) echo "sudo apk add $4" ;; *) echo "$1 설치" ;;
  esac
}
command -v cc >/dev/null || missing+=("C 컴파일러: $(hint build-essential 'gcc gcc-c++ make' base-devel build-base)")
command -v c++ >/dev/null || missing+=("C++ 컴파일러: $(hint g++ gcc-c++ gcc g++)")
[ "$arch" = x64 ] && ! command -v nasm >/dev/null && missing+=("nasm (x86 H.264 SIMD): $(hint nasm nasm nasm nasm)")
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
if ! command -v cargo >/dev/null; then
  missing+=("Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . ~/.cargo/env")
else
  need=$(sed -n 's/^rust-version = "\(.*\)"/\1/p' "$src/Cargo.toml" | head -1)
  have=$(rustc --version | awk '{print $2}')
  if [ -n "$need" ] && [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)" != "$need" ]; then
    if command -v rustup >/dev/null; then echo "==> Rust $have < $need: rustup update stable"; [ $check = 1 ] || rustup update stable
    else missing+=("Rust $need 이상 (지금 $have): 배포판 rustc 대신 https://rustup.rs"); fi
  fi
fi
# an SBC with little memory: LTO of the release profile needs ~1.5 GB
mem_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
swap_kb=$(awk '/SwapFree/{print $2}' /proc/meminfo 2>/dev/null || echo 0)
if [ $((mem_kb + swap_kb)) -lt 1500000 ]; then
  echo "주의: 사용 가능한 메모리+스왑이 $(( (mem_kb + swap_kb) / 1024 ))MB — 빌드가 메모리 부족으로 죽으면 스왑을 늘리세요 (라즈베리 파이: sudo dphys-swapfile … CONF_SWAPSIZE=2048)"
  export CARGO_BUILD_JOBS=1
fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "빌드에 필요한 것이 없습니다:"; printf '  - %s\n' "${missing[@]}"; exit 1
fi
[ $check = 1 ] && { echo "도구 준비됨: $(rustc --version), $(cc --version | head -1)"; exit 0; }

# ---- build ---------------------------------------------------------------------------------------------
ver=$(sed -n 's/^version = "\(.*\)"/\1/p' "$src/Cargo.toml" | head -1)
echo "==> aidev-runner $ver linux-$arch 빌드 (처음에는 의존성 컴파일로 몇 분~수십 분)"
cd "$src"
cargo build --release --locked
out="dist/aidev-runner-$ver-linux-$arch"
mkdir -p dist && cp target/release/aidev-runner "$out" && chmod 755 "$out"
name=$(basename "$out")
(cd dist && { grep -v "  $name\$" SHA256SUMS 2>/dev/null || true; sha256sum "$name"; } > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS)
"$out" --version
echo "==> $src/$out"
if [ $install = 1 ]; then exec "$here/install-linux.sh" --file "$src/$out" "${pass[@]}"; fi
echo "설치: scripts/install-linux.sh --file $out [--code <페어링 코드>]"
