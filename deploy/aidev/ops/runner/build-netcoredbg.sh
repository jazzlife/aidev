#!/bin/bash
# Mac (Apple Silicon): build netcoredbg for macOS arm64 — Samsung publishes no osx-arm64 release — and add it
# to ops/runner/dist/adapters/ (+ manifest.json "netcoredbg-darwin-arm64"). The release then serves it at
# /_runner/adapters/ and every Apple Silicon runner debugs .NET 6+ natively (runner dap_adapters.rs).
#   ./runner/build-netcoredbg.sh
# Needs: Xcode command line tools (clang), cmake (brew install cmake), git, and a .NET SDK (brew install --cask
# dotnet-sdk). netcoredbg's cmake downloads the CoreCLR sources it builds against.
set -euo pipefail
TAG=3.1.3-1062
OPS=$(cd "$(dirname "$0")/.." && pwd)
OUT="$OPS/runner/dist/adapters"
[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "Apple Silicon Mac에서 실행하세요 (지금: $(uname -s)-$(uname -m))"; exit 1; }
for t in git cmake clang dotnet; do command -v $t >/dev/null || { echo "$t 필요 — cmake: brew install cmake · dotnet: brew install --cask dotnet-sdk · clang: xcode-select --install"; exit 1; }; done
work=$(mktemp -d /tmp/netcoredbg.XXXX); trap 'rm -rf "$work"' EXIT
echo "==> netcoredbg $TAG 소스"
git clone --depth 1 --branch "$TAG" https://github.com/Samsung/netcoredbg.git "$work/src"
mkdir -p "$work/src/build" && cd "$work/src/build"
echo "==> cmake (CoreCLR 소스를 내려받습니다, 몇 분 걸립니다)"
CC=clang CXX=clang++ cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_INSTALL_PREFIX="$work/pkg/netcoredbg"
make -j"$(sysctl -n hw.ncpu)" && make install
test -x "$work/pkg/netcoredbg/netcoredbg" || { echo "빌드 결과에 netcoredbg가 없습니다"; exit 1; }
file "$work/pkg/netcoredbg/netcoredbg" | grep -q arm64 || { echo "arm64 바이너리가 아닙니다"; exit 1; }
"$work/pkg/netcoredbg/netcoredbg" --version | head -1
mkdir -p "$OUT"
name="netcoredbg-$TAG-darwin-arm64.tar.gz"
tar -C "$work/pkg" -czf "$OUT/$name" netcoredbg
sha=$(shasum -a 256 "$OUT/$name" | cut -d' ' -f1)
python3 - "$OUT/manifest.json" "$name" "$sha" "$TAG" <<'PY'
import json, os, sys
path, name, sha, ver = sys.argv[1:]
m = json.load(open(path)) if os.path.exists(path) else {}
m["netcoredbg-darwin-arm64"] = {"file": name, "sha256": sha, "version": ver}
json.dump(m, open(path, "w"), indent=2); open(path, "a").write("\n")
PY
echo "==> $OUT/$name ($sha)"
echo "   다음 배포에 포함됩니다 — Claude에게 'netcoredbg 빌드 끝' 이라고 알려 주세요."
