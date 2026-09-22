#!/usr/bin/env bash
# Release management ON the AI-PC. No image builds; the docker CLI is used only to run
# short-lived helper containers against the `aidev_app` volume and to restart processes.
#
#   release.sh install <release-<sha>.tgz>   unpack into releases/<sha>/, build deps if the lockfile is new
#   release.sh activate <sha>                atomic `current` swap (no process is touched)
#   release.sh restart <what...>             gateway | runtime-manager | runtimes | all   (~3 s each)
#   release.sh rollback [sha]                activate previous (or given) release
#   release.sh diff <shaA> <shaB>            which components differ -> tells what needs a restart
#   release.sh list | status | prune
set -euo pipefail
VOL="${AIDEV_APP_VOLUME:-aidev_app}"
# One release operation at a time per host (deploys, rollbacks, restarts must not interleave).
if [ -z "${AIDEV_RELEASE_LOCKED:-}" ]; then exec env AIDEV_RELEASE_LOCKED=1 flock -w 600 /tmp/aidev-release.lock "$0" "$@"; fi
HELPER=node:22-bookworm          # same glibc as the runtime images -> native modules match
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓ \033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m ✗ \033[0m %s\n' "$*" >&2; exit 1; }
# Run a shell snippet inside the volume as the app user (1001). $1 = script, stdin passed through.
vol()   { docker run --rm --user 1001:1001 -e HOME=/tmp -v "$VOL:/srv/app" -w /srv/app "$HELPER" bash -ec "$1" </dev/null; }
volin() { docker run --rm -i --user 1001:1001 -e HOME=/tmp -v "$VOL:/srv/app" -w /srv/app "$HELPER" bash -ec "$1"; }
volroot() { docker run --rm -v "$VOL:/srv/app" -w /srv/app "$HELPER" bash -ec "$1" </dev/null; }
current() { vol 'readlink current 2>/dev/null | sed "s#releases/##"' || true; }
gw() { docker run --rm --network npm_bridge curlimages/curl:8.16.0 -fsS -m 5 "http://aidev-auth-gateway:8080/_gateway/$1"; }

ensure_volume() {
  docker volume inspect "$VOL" >/dev/null 2>&1 || docker volume create --label com.docker.compose.project=aidev --label com.docker.compose.volume=app "$VOL" >/dev/null
  volroot 'mkdir -p releases deps && chown 1001:1001 /srv/app releases deps'
}

cmd_install() {
  local tgz="${1:?release tgz}"; [ -f "$tgz" ] || fail "$tgz not found"
  ensure_volume
  local sha; sha=$(tar tzf "$tgz" | head -1 | cut -d/ -f1); [ -n "$sha" ] || fail "bad archive"
  if vol "test -f releases/$sha/RELEASE"; then ok "release $sha already installed"; else
    log "installing release $sha"
    volin "rm -rf releases/$sha.partial && mkdir releases/$sha.partial && tar xzf - -C releases/$sha.partial --strip-components=1" < "$tgz"
    vol "mv releases/$sha.partial releases/$sha"
  fi
  local happ hgw hrm
  happ=$(vol "node -p 'require(\"/srv/app/releases/$sha/manifest.json\").deps.app'")
  hgw=$(vol "node -p 'require(\"/srv/app/releases/$sha/manifest.json\").deps.gateway'")
  hrm=$(vol "node -p 'require(\"/srv/app/releases/$sha/manifest.json\").deps[\"runtime-manager\"]'")
  deps_from_release app "$sha" "$happ" "." "better-sqlite3 bcrypt node-pty"
  deps_from_release gateway "$sha" "$hgw" "control/gateway" "better-sqlite3"
  deps_from_release runtime-manager "$sha" "$hrm" "control/runtime-manager" ""
  vol "cd releases/$sha && ln -sfn ../../deps/app-$happ/node_modules node_modules \
       && ln -sfn ../../../../deps/gateway-$hgw/node_modules control/gateway/node_modules \
       && ln -sfn ../../../../deps/runtime-manager-$hrm/node_modules control/runtime-manager/node_modules"
  # smoke: the entrypoints and native modules load
  vol "cd releases/$sha && node -e 'require(\"./node_modules/better-sqlite3\"); require(\"./node_modules/bcrypt\"); require(\"./node_modules/node-pty\"); console.log(\"app natives ok\")' \
       && node -e 'require(\"./control/gateway/node_modules/better-sqlite3\"); console.log(\"gateway natives ok\")'"
  ok "release $sha installed (not active). activate with: release.sh activate $sha"
  echo "$sha"
}
deps_from_release() { # comp sha hash subdir natives
  local comp="$1" sha="$2" hash="$3" sub="$4" natives="$5"; local key="$comp-$hash"
  if vol "test -f deps/$key/.complete"; then ok "deps $key present"; return; fi
  log "deps $key: npm ci --omit=dev in $HELPER (only because this lockfile is new)"
  vol "rm -rf deps/$key.partial && mkdir -p deps/$key.partial && cp releases/$sha/$sub/package.json releases/$sha/$sub/package-lock.json deps/$key.partial/ \
       && cd deps/$key.partial && export npm_config_cache=/tmp/npm ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0 \
       && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error \
       && { [ -z '$natives' ] || npm rebuild $natives --loglevel=error; } \
       && touch .complete && cd .. && mv $key.partial $key" 2>&1 | tail -5
  ok "deps $key built"
}

cmd_activate() {
  local sha="${1:?sha}"; vol "test -f releases/$sha/RELEASE" || fail "release $sha not installed"
  local prev; prev=$(current)
  vol "ln -sfn releases/$sha current.tmp && mv -Tf current.tmp current && { [ -n '$prev' ] && echo '$prev' > previous || true; }"
  ok "current -> $sha (was: ${prev:-none}). Processes keep running the old code until restarted."
}
# --- runtime rolling restart, built for many users ---------------------------------
# Probe a runtime's own /health from inside its network namespace (does not wait for the
# 30 s Docker healthcheck interval).
probe() { docker exec "$1" node -e "fetch('http://127.0.0.1:3001/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; }
# Established client connections to :3001 (WebSocket chat/terminal sessions count here).
busy_count() { docker exec "$1" node -e '
  const t=require("fs").readFileSync("/proc/net/tcp","utf8").split("\n").slice(1);
  let n=0; for (const l of t){ const f=l.trim().split(/\s+/); if(f.length>3 && f[1].endsWith(":0BB9") && f[3]==="01") n++; }
  console.log(n)' 2>/dev/null || echo 0; }
running_release() { docker exec "$1" cat /tmp/aidev-release 2>/dev/null || echo '?'; }
restart_one() { # <container> <want>  (runs in a subshell under xargs)
  local c="$1" want="$2" t0; t0=$(date +%s)
  docker restart -t 10 "$c" >/dev/null 2>&1 || { echo "FAIL $c: docker restart failed"; return 1; }
  for i in $(seq 1 90); do probe "$c" && { echo "OK   $c $(running_release "$c") in $(( $(date +%s) - t0 ))s"; return 0; }; sleep 1; done
  echo "FAIL $c: not healthy after 90s (docker logs $c)"; return 1
}
export -f probe busy_count running_release restart_one
cmd_restart() {
  local batch=6 drain=0 canary=0 only="" force=0
  local targets=()
  while [ $# -gt 0 ]; do case "$1" in
    --batch) batch="$2"; shift 2;;      # parallel restarts
    --drain) drain=1; shift;;           # idle runtimes first; runtimes with live sessions are deferred (not restarted)
    --force) force=1; shift;;           # with --drain: restart busy ones too, after the idle ones
    --canary) canary=1; shift;;         # restart exactly one runtime, then stop
    --only) only="$2"; shift 2;;        # comma-separated runtime names
    gateway|runtime-manager|runtimes|all) targets+=("$1"); shift;;
    *) fail "restart: [--batch N] [--drain [--force]] [--canary] [--only a,b] gateway | runtime-manager | runtimes | all";;
  esac; done
  for what in "${targets[@]}"; do case $what in
    gateway)         docker restart -t 5 aidev-auth-gateway >/dev/null; for i in $(seq 1 30); do gw health >/dev/null 2>&1 && break; sleep 1; done; gw health >/dev/null || fail "gateway did not come back"; ok "gateway restarted: $(gw release)";;
    runtime-manager) docker restart -t 5 aidev-runtime-manager >/dev/null; for i in $(seq 1 40); do docker exec aidev-runtime-manager node -e "fetch('http://127.0.0.1:8090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; sleep 1; done; ok "runtime-manager restarted";;
    all) cmd_restart --batch "$batch" $([ $drain = 1 ] && echo --drain) $([ $force = 1 ] && echo --force) runtime-manager gateway runtimes;;
    runtimes)
      local want; want=$(current)
      local idle=() busy=() skipped=0
      while read -r c; do
        [ -n "$c" ] || continue
        if [ -n "$only" ]; then case ",$only," in *",${c#aidev-cloudcli-},"*) ;; *) continue;; esac; fi
        if [ "$(running_release "$c")" = "$want" ]; then skipped=$((skipped+1)); continue; fi
        if [ $drain = 1 ] && [ "$(busy_count "$c")" -gt 0 ]; then busy+=("$c"); else idle+=("$c"); fi
      done < <(docker ps --filter label=work.nado.aidev.managed=true --filter status=running --format '{{.Names}}')
      log "runtimes -> $want: ${#idle[@]} to restart now, ${#busy[@]} with live sessions, $skipped already current (batch $batch)"
      [ $canary = 1 ] && [ ${#idle[@]} -gt 0 ] && { idle=("${idle[0]}"); busy=(); log "canary: ${idle[0]} only"; }
      local failed=0
      if [ ${#idle[@]} -gt 0 ]; then
        printf '%s\n' "${idle[@]}" | xargs -P "$batch" -I{} bash -c 'restart_one "$1" "$2"' _ {} "$want" | tee /tmp/aidev-restart.log
        failed=$(grep -c '^FAIL' /tmp/aidev-restart.log || true)
      fi
      if [ ${#busy[@]} -gt 0 ]; then
        if [ $force = 1 ]; then
          log "restarting ${#busy[@]} busy runtime(s) (--force)"
          printf '%s\n' "${busy[@]}" | xargs -P "$batch" -I{} bash -c 'restart_one "$1" "$2"' _ {} "$want" | tee -a /tmp/aidev-restart.log
          failed=$(grep -c '^FAIL' /tmp/aidev-restart.log || true)
        else
          echo " ! deferred (live sessions): ${busy[*]}"; echo "   re-run later:  release.sh restart --drain runtimes   (or --force)"
        fi
      fi
      [ "$failed" = 0 ] && ok "runtimes done" || fail "$failed runtime(s) failed to come back — see above";;
  esac; done
}
cmd_diff() { # prints component names whose files differ between two releases
  local a="${1:?}" b="${2:?}"
  vol "cd releases; d(){ diff -rq --no-dereference \"$a/\$1\" \"$b/\$1\" >/dev/null 2>&1 || echo \"\$2\"; }
       d dist frontend; d dist-server server; d shared server; d public frontend; d runtime server; d node_modules server;
       d control/gateway gateway; d control/runtime-manager runtime-manager" | sort -u
}
cmd_rollback() { local to="${1:-}"; [ -n "$to" ] || to=$(vol 'cat previous 2>/dev/null'); [ -n "$to" ] || fail "no previous release"; cmd_activate "$to"; }
cmd_list() { vol 'ls -1 releases; echo "deps: $(ls -1 deps | tr "\n" " ")"; echo "current -> $(readlink current 2>/dev/null)"; echo "previous: $(cat previous 2>/dev/null)"'; }
cmd_status() {
  echo "current release: $(current)"; echo "gateway: $(gw release 2>/dev/null || echo unreachable)"
  echo "runtime-manager: $(docker inspect aidev-runtime-manager --format '{{.State.Health.Status}} {{.Config.Image}}' 2>/dev/null)"
  echo "--- managed runtimes (name  state  image  running-release)"
  docker ps -a --filter label=work.nado.aidev.managed=true --format '{{.Names}}\t{{.State}}\t{{.Image}}' | while IFS=$'\t' read -r n s i; do
    printf '%s\t%s\t%s\t%s\n' "$n" "$s" "$i" "$( [ "$s" = running ] && docker exec "$n" cat /tmp/aidev-release 2>/dev/null || echo -)"; done
}
cmd_prune() { # keep current, previous and the 3 newest releases; drop deps nobody links
  vol 'cur=$(readlink current | sed "s#releases/##"); prev=$(cat previous 2>/dev/null); keep="$cur $prev $(ls -1t releases | head -3)";
       for r in $(ls -1 releases); do case " $keep " in *" $r "*) ;; *) rm -rf "releases/$r"; echo "removed release $r";; esac; done
       used=$(find releases -maxdepth 4 -type l -name node_modules -exec readlink {} \; | xargs -n1 basename -a 2>/dev/null | sort -u; find releases -maxdepth 4 -type l -name node_modules -exec readlink {} \; | sed "s#.*/deps/##; s#/node_modules##" | sort -u)
       for d in $(ls -1 deps); do case " $used " in *" $d "*) ;; *) rm -rf "deps/$d"; echo "removed deps $d";; esac; done'
}
case "${1:-}" in
  install) cmd_install "$2";; activate) cmd_activate "$2";; restart) shift; cmd_restart "$@";;
  rollback) cmd_rollback "${2:-}";; diff) cmd_diff "$2" "$3";; list) cmd_list;; status) cmd_status;; prune) cmd_prune;;
  *) sed -n '2,12p' "$0"; exit 1;;
esac
