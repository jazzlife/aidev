#!/usr/bin/env bash
# Puts a GitHub runner release (built by .github/workflows/runner-release.yml on a runner-v* tag) into
# runner/dist — binaries + SHA256SUMS, and adapter-* assets as dist/adapters/ — so the next platform release
# (release/pack.sh) serves every OS/CPU. Checks each file against the release's SHA256SUMS.
#   runner/scripts/fetch-release.sh runner-v0.9.0 [owner/repo] [--out <dir>]   (default <dir>: runner/dist)
# Uses the GitHub CLI when present (`gh auth login`; needed for a private repository), else
# $GITHUB_TOKEN with the REST API, else anonymous downloads (public repository).
set -euo pipefail
tag=""; repo=jazzlife/aidev; out=""
while [ $# -gt 0 ]; do
  case $1 in --out) out=${2:?}; shift ;; */*) repo=$1 ;; *) tag=$1 ;; esac
  shift
done
[ -n "$tag" ] || { echo "usage: fetch-release.sh <runner-vX.Y.Z> [owner/repo] [--out <dir>]"; exit 2; }
runner=$(cd "$(dirname "$0")/.." && pwd)
out=${out:-$runner/dist}
# sha256sum (Linux) or shasum (macOS)
sums() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh release download "$tag" --repo "$repo" --dir "$tmp"
else
  auth=(); [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  api="https://api.github.com/repos/$repo/releases/tags/$tag"
  assets=$(curl -fsSL "${auth[@]}" "$api") || { echo "$repo 의 $tag 릴리스를 찾지 못했습니다 (비공개 저장소면 gh auth login 또는 GITHUB_TOKEN)"; exit 1; }
  printf '%s' "$assets" | python3 -c 'import json,sys; [print(a["id"], a["name"]) for a in json.load(sys.stdin)["assets"]]' | while read -r id name; do
    curl -fsSL "${auth[@]}" -H 'Accept: application/octet-stream' "https://api.github.com/repos/$repo/releases/assets/$id" -o "$tmp/$name"
  done
fi
(cd "$tmp" && sums -c --quiet SHA256SUMS) || { echo "SHA-256 확인 실패"; exit 1; }
if [ -f "$tmp/adapter-SHA256SUMS" ]; then
  # a list file, not stdin: macOS sha256sum reads the check list only from a file
  (cd "$tmp" && sed 's/  /  adapter-/' adapter-SHA256SUMS > check-adapters.sha256 && sums -c --quiet check-adapters.sha256) || { echo "어댑터 SHA-256 확인 실패"; exit 1; }
fi
mkdir -p "$out/adapters"
# the dist mirrors this release: binaries of other versions (older local builds) are not served next to it
rm -f "$out"/aidev-runner-*
for f in "$tmp"/aidev-runner-*; do [ "$(basename "$f")" = aidev-runner-src.tar.gz ] && continue; cp "$f" "$out/"; chmod 755 "$out/$(basename "$f")"; done
for f in "$tmp"/adapter-*; do n=$(basename "$f"); [ "$n" = adapter-SHA256SUMS ] && continue; cp "$f" "$out/adapters/${n#adapter-}"; done
(cd "$out" && sums aidev-runner-* > SHA256SUMS)
ls -la "$out" "$out/adapters"
