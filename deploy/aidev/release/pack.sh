#!/usr/bin/env bash
# Build a release tarball OFF the AI-PC (cloud workspace / CI). Pure JS output only —
# native modules are built on the AI-PC from the lockfiles shipped here.
#   pack.sh [out-dir]   -> <out-dir>/release-<sha>.tgz  (+ manifest.json inside)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd); cd "$ROOT"
sha=$(git rev-parse --short=12 HEAD); git diff --quiet HEAD || sha="$sha-dirty"
out=$(mkdir -p "${1:-$ROOT/.release}" && cd "${1:-$ROOT/.release}" && pwd)
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
R="$stage/$sha"; mkdir -p "$R/control/gateway" "$R/control/runtime-manager" "$R/runtime"

echo "==> app: vite + tsc"
npm run build >/dev/null
cp -a dist dist-mobile dist-server public shared package.json package-lock.json "$R/"
echo "==> control plane: tsc"
for c in gateway:auth-gateway runtime-manager:runtime-manager; do
  name=${c%%:*}; dir=deploy/aidev/${c##*:}
  ( cd "$dir" && [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error >/dev/null; npm run build >/dev/null )
  cp -a "$dir/dist" "$dir/package.json" "$dir/package-lock.json" "$R/control/$name/"; [ -d "$dir/data" ] && cp -a "$dir/data" "$R/control/$name/"
done
cp -a deploy/aidev/runtime/entrypoint.mjs "$R/runtime/"
mkdir -p "$R/control/laya" && cp -a deploy/aidev/laya/app/. "$R/control/laya/"   # python, no build step
# aidev-runner binaries built so far (deploy/aidev/runner/build.sh; macOS ones come from the Mac) → served at /_runner/download
if ls deploy/aidev/runner/dist/aidev-runner-* >/dev/null 2>&1; then mkdir -p "$R/control/runner" && cp -a deploy/aidev/runner/dist/. "$R/control/runner/"; fi
# routing benchmark needs the seed catalog exactly as the gateway sends it to Laya
node --input-type=module -e "import('$ROOT/deploy/aidev/auth-gateway/dist/seed-agents.js').then(m=>console.log(JSON.stringify(Object.fromEntries(m.seedAgents.filter(a=>a.domain!=='meta').map(a=>[a.name,{hint:a.hint,description:a.description,domain:a.domain}])),null,1)))" > "$R/control/laya/bench/catalog.json"
echo "$sha" > "$R/RELEASE"
h() { sha256sum "$1" | cut -c1-12; }
cat > "$R/manifest.json" <<EOF
{ "release": "$sha", "created": "$(date -u +%FT%TZ)", "commit": "$(git rev-parse HEAD)",
  "deps": { "app": "$(h package-lock.json)", "gateway": "$(h deploy/aidev/auth-gateway/package-lock.json)", "runtime-manager": "$(h deploy/aidev/runtime-manager/package-lock.json)" } }
EOF
tar czf "$out/release-$sha.tgz" -C "$stage" "$sha"
echo "$out/release-$sha.tgz ($(du -h "$out/release-$sha.tgz" | cut -f1))"
