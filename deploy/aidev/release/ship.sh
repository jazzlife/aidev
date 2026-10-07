#!/usr/bin/env bash
# Ship from the AI-PC itself (OPS-02, 2026-10-04): no Mac in the loop. runtime-manager starts this in a short-lived
# `aidev-ship-<id>` container (node:22-bookworm: git, build tools for the native modules) with
#   /var/run/docker.sock + the host's docker CLI   to install and activate the release like deploy.sh does on the host
#   /tmp (host)                                   the host-wide release lock and restart log release.sh uses
#   /ship  (volume aidev_ship)                     the build checkout (node_modules kept between ships) and the releases
#   /from  (the requester's workspace, read-only)  where the agent committed, when SHIP_FROM is set
#   /srv/app (aidev_app, read-only)                the active release: its runner binaries are carried over
#   /run/ship-secrets/github-token (optional)      to push the shipped commit to GitHub main (host ~/aidev/ship-secrets)
# Steps: fetch → fast-forward check → install deps → typecheck · lint · client tests · server tests → pack →
# deploy.sh → check the gateway serves the new release and both apps' entry bundles → push to GitHub main →
# finish draining runtimes that had live sessions. Any failure before deploy changes nothing; a failed check after
# deploy rolls back. The last line the gateway reads: SHIP_RESULT <ok|failed|rolled_back|push_failed> <sha> <text>.
set -uo pipefail
REPO_URL="https://github.com/${SHIP_GITHUB_REPO:-jazzlife/aidev}.git"
SRC=/ship/src; OUT=/ship/releases; TOKEN_FILE=${SHIP_TOKEN_FILE:-/run/ship-secrets/github-token}
SHA=""; STAGE=""
step() { STAGE="$1"; echo "SHIP_STEP $1"; }
result() { echo "SHIP_RESULT $1 ${SHA:-none} $2"; exit 0; }
die() { echo " ✗ $STAGE: $1" >&2; result failed "$STAGE: $1"; }
run() { "$@" || die "$* failed (exit $?)"; }

git config --global --add safe.directory '*'
git config --global user.name "${SHIP_GIT_NAME:-NadoVibe}"; git config --global user.email "${SHIP_GIT_EMAIL:-nadovibe@nado.work}"
export npm_config_cache=/ship/npm-cache npm_config_audit=false npm_config_fund=false npm_config_loglevel=error CI=1

step fetch
if [ ! -d "$SRC/.git" ]; then git clone -q "$REPO_URL" "$SRC" || die "clone $REPO_URL"; fi
cd "$SRC" || die "no checkout"
git remote set-url origin "$REPO_URL"
git fetch -q origin main || die "fetch origin main"
if [ -n "${SHIP_FROM:-}" ]; then
  [ -d "/from/$SHIP_FROM/.git" ] || die "/workspace/$SHIP_FROM is not a git repository"
  git fetch -q "/from/$SHIP_FROM" "${SHIP_REF:-HEAD}" || die "fetch ${SHIP_REF:-HEAD} from /workspace/$SHIP_FROM"
  SHA=$(git rev-parse FETCH_HEAD)
else
  SHA=$(git rev-parse "origin/${SHIP_REF:-main}" 2>/dev/null || git rev-parse "${SHIP_REF}") || die "unknown ref ${SHIP_REF:-main}"
fi
# only what continues GitHub main: anything else would be lost on the next ship or fork the history
git merge-base --is-ancestor origin/main "$SHA" || die "$SHA does not continue GitHub main ($(git rev-parse --short origin/main)) — rebase onto it first"
NEEDS_PUSH=0; [ "$(git rev-parse origin/main)" = "$SHA" ] || NEEDS_PUSH=1
[ $NEEDS_PUSH = 0 ] || [ -s "$TOKEN_FILE" ] || die "no GitHub token on the server (~/aidev/ship-secrets/github-token): the commit could not reach GitHub after deploy"
git checkout -q --force --detach "$SHA" && git clean -qfdx -e node_modules -e 'deploy/aidev/*/node_modules' || die "checkout $SHA"
echo "commit $(git log -1 --format='%h %s')"

step deps
lock_hash() { sha256sum package-lock.json deploy/aidev/auth-gateway/package-lock.json deploy/aidev/runtime-manager/package-lock.json | sha256sum | cut -c1-16; }
if [ "$(cat node_modules/.ship-lock 2>/dev/null)" != "$(lock_hash)" ]; then
  run npm ci
  for d in deploy/aidev/auth-gateway deploy/aidev/runtime-manager; do (cd "$d" && npm ci) || die "npm ci in $d"; done
  lock_hash > node_modules/.ship-lock
else echo "deps unchanged"; fi

step checks
run npm run typecheck
run npm run lint
run npm run test:client
run npm test
for d in deploy/aidev/auth-gateway deploy/aidev/runtime-manager; do
  if node -e "process.exit(require('./$d/package.json').scripts?.test ? 0 : 1)"; then (cd "$d" && npm test) || die "tests in $d"; fi
done

step pack
# the runner binaries are built by CI (a runner-v* tag publishes a GitHub release): the newest release when it is newer
# than what the active release serves, else the active release's own (also when GitHub cannot be reached)
rm -rf deploy/aidev/runner/dist && mkdir -p deploy/aidev/runner/dist
serving=$(ls /srv/app/current/control/runner 2>/dev/null | sed -n 's/^aidev-runner-\([0-9][0-9.]*\)-.*/\1/p' | sort -V | tail -1)
newest=$(curl -fsSL -m 20 "https://api.github.com/repos/${SHIP_GITHUB_REPO:-jazzlife/aidev}/releases?per_page=30" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).find(x=>!x.draft&&!x.prerelease&&/^runner-v[0-9.]+$/.test(x.tag_name));console.log(r?r.tag_name.slice(8):"")}catch{console.log("")}})')
if [ -n "$newest" ] && [ "$newest" != "$serving" ] && [ "$(printf '%s\n%s\n' "${serving:-0}" "$newest" | sort -V | tail -1)" = "$newest" ] \
   && bash deploy/aidev/runner/scripts/fetch-release.sh "runner-v$newest" "${SHIP_GITHUB_REPO:-jazzlife/aidev}" --out deploy/aidev/runner/dist; then
  echo "runner $newest from its GitHub release (was ${serving:-none})"
else
  rm -rf deploy/aidev/runner/dist && mkdir -p deploy/aidev/runner/dist
  if [ -d /srv/app/current/control/runner ]; then
    cp -a /srv/app/current/control/runner/. deploy/aidev/runner/dist/ && rm -rf deploy/aidev/runner/dist/scripts deploy/aidev/runner/dist/source
  fi
  echo "runner ${serving:-none} carried over"
fi
mkdir -p "$OUT"
tgz=$(bash deploy/aidev/release/pack.sh "$OUT" | tail -1 | cut -d' ' -f1) || die "pack.sh"
[ -s "$tgz" ] || die "pack.sh produced no archive"
case "$tgz" in *-dirty.tgz) die "the checkout was not clean";; esac
REL=$(tar xzOf "$tgz" --wildcards '*/RELEASE' | tr -d '[:space:]')
echo "release $REL ($tgz)"

step deploy
PREV=$(docker run --rm -v aidev_app:/srv/app node:22-bookworm-slim sh -c 'readlink /srv/app/current 2>/dev/null | sed "s#releases/##"' </dev/null)
DEPLOY_LOG=$(mktemp /tmp/aidev-ship-deploy-XXXXXX.log); DRAIN_LOG=$(mktemp /tmp/aidev-ship-drain-XXXXXX.log)
trap 'rm -f "$DEPLOY_LOG" "$DRAIN_LOG"' EXIT
bash deploy/aidev/release/deploy.sh "$tgz" | tee "$DEPLOY_LOG"
if [ "${PIPESTATUS[0]}" != 0 ]; then
  NOW=$(docker run --rm -v aidev_app:/srv/app node:22-bookworm-slim sh -c 'readlink /srv/app/current 2>/dev/null | sed "s#releases/##"' </dev/null)
  # failed before the switch: nothing changed; after it: put the previous release back
  [ "$NOW" = "$PREV" ] && result failed "deploy.sh failed before switching; still on $PREV"
  [ -n "$PREV" ] && bash deploy/aidev/release/release.sh rollback "$PREV"
  result rolled_back "deploy.sh failed; back on $PREV"
fi

step verify
gw() { docker run --rm --network npm_bridge curlimages/curl:8.16.0 -fsS -m 10 "http://aidev-auth-gateway:8080$1" </dev/null; }
entry() { grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1; }
problem=""
live=$(gw /_gateway/release | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).release)}catch{console.log("")}})')
[ "$live" = "$REL" ] || problem="gateway serves release '${live:-?}', not $REL"
[ -n "$problem" ] || [ "$(gw /m/ | entry)" = "$(entry < dist-mobile/index.html)" ] || problem="/m/ does not serve the new mobile bundle"
[ -n "$problem" ] || [ "$(gw / | entry)" = "$(entry < dist/index.html)" ] || problem="/ does not serve the new workbench bundle"
if [ -n "$problem" ]; then
  echo " ✗ $problem" >&2
  [ -n "$PREV" ] && bash deploy/aidev/release/release.sh rollback "$PREV"
  result rolled_back "$problem; back on ${PREV:-?}"
fi
echo " ✓ live: $REL"

step push
if [ $NEEDS_PUSH = 1 ]; then
  if ! git -c credential.helper= -c "credential.helper=!f(){ echo username=x-access-token; echo password=\$(cat $TOKEN_FILE); };f" push -q origin "$SHA:refs/heads/main"; then
    result push_failed "deployed $REL but GitHub main did not take $SHA (moved on meanwhile?) — push it by hand"
  fi
  echo " ✓ GitHub main → $(git rev-parse --short "$SHA")"
fi
echo "SHIP_RESULT ok $SHA release $REL is live"

# runtimes still on an older release (a live chat deferred them, now or in an earlier ship): restart each once its
# chats are idle, for up to 30 min (a newer ship stops this wait and takes over)
for _ in $(seq 1 31); do
  bash deploy/aidev/release/release.sh restart --drain runtimes 2>&1 | tee "$DRAIN_LOG" | tail -2
  grep -q 'deferred (live sessions)' "$DRAIN_LOG" || { echo " ✓ every runtime runs $REL"; exit 0; }
  sleep 60
done
echo " ! some runtimes still run an older release (live chats); the next ship restarts them"
