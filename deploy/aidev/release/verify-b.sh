#!/usr/bin/env bash
# Stage B server verification (IMPLEMENTATION-PLAN B-13 … B-17). Runs ON the AI-PC:
#   verify-b.sh USERNAME [--bench] [--backup] [--experiments] [--security]
#     --security (F-11): allowed_roots escapes on the online PC, an agent rm -rf waits for approval (denied here),
#     and a throw-away runner (in a container on the proxy network) without screen consent, deleted at the end
#     no password: a 10-minute gateway session is minted inside the gateway container
#     (manage-users session) and revoked at the end — nothing is typed or leaves the AI-PC.
#   AIDEV_PASS=… verify-b.sh USERNAME …   (or USERNAME PASSWORD …, legacy) logs in like the browser
# Talks to the gateway over the proxy network exactly like the browser does, then reads
# container logs. Prints PASS/FAIL per check; exit 1 when any check fails.
set -uo pipefail
user=${1:?username}; shift
pass=""; if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then pass=$1; shift; else pass=${AIDEV_PASS:-}; fi
bench=0; backup=0; experiments=0; security=0; for a in "$@"; do case "$a" in --bench) bench=1;; --backup) backup=1;; --experiments) experiments=1;; --security) security=1;; esac; done
NET=${AIDEV_PROXY_NETWORK:-npm_bridge}
GW=http://aidev-auth-gateway:8080
CURL="docker run --rm -i --network $NET curlimages/curl:8.16.0 -sS -m 30"
fail=0
check() { if node -e "const j=JSON.parse(process.argv[1]); process.exit(($2)?0:1)" "$1" 2>/dev/null; then echo "PASS $3"; else echo "FAIL $3 :: $(echo "$1" | cut -c1-300)"; fail=1; fi; }
have_node() { command -v node >/dev/null 2>&1; }
if ! have_node; then
  # no node on the host: evaluate checks inside the gateway image
  check() { if docker run --rm -i node:22-bookworm-slim node -e "const j=JSON.parse(process.argv[1]); process.exit(($2)?0:1)" "$1" 2>/dev/null; then echo "PASS $3"; else echo "FAIL $3 :: $(echo "$1" | cut -c1-300)"; fail=1; fi; }
fi
jeval() { if have_node; then node -e "const j=JSON.parse(process.argv[1]); console.log(($2))" "$1" 2>/dev/null; else docker run --rm -i node:22-bookworm-slim node -e "const j=JSON.parse(process.argv[1]); console.log(($2))" "$1" 2>/dev/null; fi; }
jget() { $CURL -H "authorization: Bearer $TOK" "$GW$1"; }
jpost() { $CURL -X "${3:-POST}" -H "authorization: Bearer $TOK" -H 'content-type: application/json' --data-binary "$2" "$GW$1"; }

echo "## release"
$CURL "$GW/_gateway/release"; echo
echo "## gateway log (seed / errors)"
docker logs --tail 50 aidev-auth-gateway 2>&1 | grep -E "seeded|gateway\]" | tail -5
echo "## accounts (engines column)"
docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js list 2>&1 | head -40

MU="docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js"
if [ -n "$pass" ]; then
  echo "## login as $user"
  TOK=$($CURL -X POST -H 'content-type: application/json' --data-binary "{\"username\":\"$user\",\"password\":\"$pass\"}" "$GW/api/auth/login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$TOK" ] || { echo "FAIL login"; exit 1; }
  echo "PASS login"
else
  echo "## server-side session for $user (10 min, revoked at exit)"
  read -r TOK SID < <($MU session "$user" 2>/dev/null | tail -1)
  [ -n "${TOK:-}" ] && [ -n "${SID:-}" ] || { echo "FAIL session (gateway release without 'manage-users session'? deploy first)"; exit 1; }
  trap '$MU end-session "$SID" >/dev/null 2>&1' EXIT
  echo "PASS session"
fi

r=$(jget /api/aidev/laya/health); check "$r" 'j.status==="ok" && j.device' "laya health ($(echo "$r" | sed -n 's/.*"device": *"\([^"]*\)".*/\1/p'))"
r=$(jget /api/aidev/agents); check "$r" 'j.agents.length>=13' "catalog seeded ($(echo "$r" | grep -o '"name"' | wc -l) agents)"
r=$(jget /api/aidev/engines); check "$r" 'j.engines && j.engines.claude && j.engines.codex' "engines: $(echo "$r" | cut -c1-200)"
r=$(jpost /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘"}'); check "$r" 'j.agent && j.decision_id>0' "route react → $(echo "$r" | sed -n 's/.*"agent":{"id":[0-9]*,"name":"\([^"]*\)".*/\1/p') fallback=$(echo "$r" | sed -n 's/.*"fallback":\([a-z]*\).*/\1/p') plan=$(echo "$r" | grep -o '"plan":{[^}]*' | grep -oE '"(engine|model|effort)":("[^"]*"|null)' | cut -d: -f2 | tr -d '"' | tr '\n' ' ') laya_ms=$(echo "$r" | sed -n 's/.*"latency_ms":\([0-9.]*\).*/\1/p')"
check "$r" 'j.agent.name==="frontend-react"' "route react picks frontend-react"
r=$(jpost /api/aidev/route '{"text":"이 로그 파일 5만 줄을 읽고 분석해서 오류 패턴을 요약해줘"}'); check "$r" 'j.scope.task_kind==="bulk_read"' "bulk_read recognised (task_kind=$(echo "$r" | sed -n 's/.*"task_kind":"\([^"]*\)".*/\1/p'), engine=$(echo "$r" | sed -n 's/.*"plan":{"engine":\("[^"]*"\|null\).*/\1/p'))"
r=$(jpost /api/aidev/route '{"text":"Unity 셰이더로 물 표면 굴절 효과를 구현해줘"}'); check "$r" 'j.decision' "unknown domain → decision=$(echo "$r" | sed -n 's/.*"decision":"\([^"]*\)".*/\1/p') needs_new=$(echo "$r" | sed -n 's/.*"needs_new":\([0-9.]*\).*/\1/p')"
r=$(jpost /api/aidev/decide/remote.approve '{"state":{"command":"rm -rf ~/projects && npm ci"}}'); check "$r" 'typeof j.answer==="number"' "decide remote.approve → $(echo "$r" | sed -n 's/.*"answer":\([0-9.]*\).*/\1/p')"
r=$(jpost /api/aidev/decide/agent.yesno '{"state":{"question":"Is the build green?","summary":"all 42 tests passed"}}'); check "$r" 'typeof j.answer==="number"' "decide agent.yesno → $(echo "$r" | sed -n 's/.*"answer":\([0-9.]*\).*/\1/p')"
r=$(jget "/api/aidev/decisions?limit=5"); check "$r" 'j.decisions.length>=3' "decision_log written"
echo "## routing eval on the held-out bench set (Laya-only vs lexical prior vs fused)"
r=$(jpost /api/aidev/route/eval '{}'); echo "$r" | cut -c1-600; echo "remote_action: $(jeval "$r" 'j.remote ? JSON.stringify({ n: j.remote.n, fail: j.remote.laya_failures, w: j.remote.laya_weight, min_p: j.remote.min_p, fused: j.remote.fused, laya: j.remote.laya_only, nb: j.remote.lexical_only, ko: j.remote.fused_ko, best: j.remote.best }) : "not measured"')"; check "$r" 'j.remote && j.remote.fused.accuracy>=0.8 && j.remote.fused.false_remote<=0.15' "F-08 remote_action fused accuracy >= 0.8, false remote <= 0.15"; echo "task_kind: $(echo "$r" | sed -n 's/.*"kind":{\([^}]*}\).*/\1/p' | cut -c1-400)"; check "$r" 'j.kind && j.kind.bulk_read_recall>=0.75' "task_kind fusion: bulk_read recall >= 0.75 (laya $(echo "$r" | sed -n 's/.*"kind":{[^}]*"laya_only":\([0-9.]*\).*/\1/p') nb $(echo "$r" | sed -n 's/.*"kind":{[^}]*"lexical_only":\([0-9.]*\).*/\1/p') fused $(echo "$r" | sed -n 's/.*"kind":{[^}]*"fused":\([0-9.]*\).*/\1/p') best α $(echo "$r" | sed -n 's/.*"kind":{[^}]*"best_alpha":\([0-9.]*\).*/\1/p'))"; check "$r" 'j.fused>=0.75' "fused routing accuracy >= 0.75 (laya $(echo "$r" | sed -n 's/.*"laya_only":\([0-9.]*\).*/\1/p') nb $(echo "$r" | sed -n 's/.*"lexical_only":\([0-9.]*\).*/\1/p') fused $(echo "$r" | sed -n 's/.*"fused":\([0-9.]*\).*/\1/p') best α $(echo "$r" | sed -n 's/.*"best_alpha":\([0-9.]*\).*/\1/p'))"

echo "## runner hub (F-02)"
r=$($CURL "$GW/_runner/download"); check "$r" 'Array.isArray(j.files) && j.files.length>=1' "runner binaries served ($(echo "$r" | grep -o '"platform":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' '))"
r=$($CURL -X POST -H 'content-type: application/json' --data-binary '{"code":"ZZZZ0000"}' "$GW/_runner/pair"); check "$r" 'typeof j.error==="string"' "unknown pairing code refused"
r=$(jget /api/aidev/targets); check "$r" 'Array.isArray(j.targets)' "targets: $(echo "$r" | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')online=$(echo "$r" | grep -o '"online":true' | wc -l)"
# F-03/F-05: run a harmless command on the first online target (as the user) and read its result
OTID=$(jeval "$r" '(j.targets.find(t=>t.online)||{}).id||""')
if [ -n "$OTID" ]; then
  echo "## remote exec on target #$OTID"
  r=$(jpost "/api/aidev/targets/$OTID/exec" '{"cmd":"echo aidev-verify-$((20+22)); uname -sm; pwd; command -v node >/dev/null && node -v || echo no-node","cwd":"~/aidev-work","timeoutSec":60}')
  RRV=$(echo "$r" | grep -o '"remoteRunId":[0-9]*' | head -1 | cut -d: -f2)
  check "$r" 'j.stream && j.stream.remoteRunId>0' "exec started (remote run #${RRV:-?})"
  if [ -n "$RRV" ]; then
    r=$(jget "/api/aidev/remote-runs/$RRV/wait?timeout=25")
    check "$r" 'j.run.exit_code===0 && /aidev-verify-42/.test(j.output)' "exec finished: exit=$(echo "$r" | grep -o '"exit_code":[^,]*' | head -1 | cut -d: -f2) output: $(echo "$r" | grep -o '"output":"[^"]*' | cut -d'"' -f4 | sed 's/\\n/ | /g' | cut -c1-160)"
  fi
  echo "## recent remote runs"
  jeval "$(jget "/api/aidev/remote-runs?limit=10")" 'j.runs.map(x=>`#${x.id} run=${x.run_id??"-"} ${x.approved_by} exit=${x.exit_code??"-"} ${x.finished_at?Math.round((x.finished_at-x.started_at)/1000)+"s":"RUNNING"} cwd=${x.cwd??"-"} :: ${(x.cmd||"").slice(0,90)}${x.artifacts&&x.artifacts.error?" ERR "+x.artifacts.error.slice(0,80):""}`).join("\n")'
  echo "## approvals"; jeval "$(jget "/api/aidev/approvals?all=1")" 'j.approvals.map(a=>`${a.status} risk=${a.risk} ${a.targetName}: ${a.cmd.slice(0,90)}`).join("\n")||"(none)"'
fi
echo "## recent routing decisions (signals behind each pick)"
docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js decisions 6 2>&1 | grep -v "^$" | head -24
echo "## learned tier policy (E-05) and recent changes"
docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js tier-policy 2>&1 | head -30
echo "## runtime logs: aidev routing applied (send a chat message first; B-13)"
for c in $(docker ps --format '{{.Names}}' | grep '^aidev-cloudcli-'); do
  n=$(docker logs --since 24h "$c" 2>&1 | grep -c "aidev routing"); echo "$c: $n routed turns"
  docker logs --since 24h "$c" 2>&1 | grep "aidev routing" | tail -3
done

if [ $security -eq 1 ]; then
  echo "## F-11 security checks"
  if [ -n "$OTID" ]; then
    # 1. the PC's allowed folders cannot be left: absolute path, .. and a symlink that points outside
    r=$(jpost "/api/aidev/targets/$OTID/exec" '{"cmd":"ls","cwd":"/etc"}'); check "$r" '/허용된 폴더 밖/.test(j.error)' "F-11 cwd /etc refused (allowed_roots)"
    r=$(jpost "/api/aidev/targets/$OTID/exec" '{"cmd":"ls","cwd":"~/aidev-work/../.."}'); check "$r" '/허용된 폴더 밖/.test(j.error)' "F-11 cwd ~/aidev-work/../.. refused"
    r=$(jpost "/api/aidev/targets/$OTID/exec" '{"cmd":"ln -sfn /etc .aidev-sec-link && echo linked","cwd":"~/aidev-work","timeoutSec":20}'); RL=$(jeval "$r" 'j.stream?.remoteRunId||""')
    [ -n "$RL" ] && jget "/api/aidev/remote-runs/$RL/wait?timeout=15" >/dev/null
    r=$(jpost "/api/aidev/targets/$OTID/exec" '{"cmd":"ls","cwd":"~/aidev-work/.aidev-sec-link"}'); check "$r" '/허용된 폴더 밖/.test(j.error)' "F-11 symlink to /etc inside the allowed folder refused"
    r=$(jget "/api/aidev/targets/$OTID/file?path=$(printf %s '~/aidev-work/.aidev-sec-link/passwd')"); check "$r" 'j.error' "F-11 file view through the symlink refused"
    r=$(jpost "/api/aidev/targets/$OTID/exec" '{"cmd":"rm -f .aidev-sec-link","cwd":"~/aidev-work","timeoutSec":20}')
    # 2. an agent's destructive command waits for the user — sent from the user's runtime like a real tool call
    RTN=$($MU list 2>/dev/null | node -e "const a=JSON.parse(require('fs').readFileSync(0)); console.log((a.find(x=>x.username===process.argv[1])||{}).runtime||'')" "$user" 2>/dev/null)
    RTC="aidev-cloudcli-$RTN"
    if [ -n "$RTN" ] && docker ps --format '{{.Names}}' | grep -qx "$RTC"; then
      r=$(docker exec "$RTC" node --input-type=module -e "const m=await import('/srv/app/current/dist-server/server/modules/aidev-tools/aidev-tools.service.js'); console.log(JSON.stringify(await m.callGateway('POST','/targets/$OTID/exec',{cmd:'rm -rf ~/aidev-work/.aidev-sec-probe',agent:'security-check'})))" 2>&1 | tail -1)
      AP=$(jeval "$r" 'j.approval?.id||""')
      check "$r" 'j.status==="pending" && j.approval && j.approval.destructive' "F-11 agent rm -rf waits for approval (risk $(jeval "$r" 'j.approval?.risk'))"
      if [ -n "$AP" ]; then
        r=$(jpost "/api/aidev/approvals/$AP" '{"allow":false}'); check "$r" 'j.approval.status==="denied"' "F-11 denied by the user → not run"
      fi
    else echo "SKIP F-11 agent approval (no running runtime for $user)"; fi
  fi
  # 3. a throw-away runner: no screen consent → screen/device refused; deleting the target cuts it off at once
  SEC=$(mktemp -d /tmp/aidev-sec-XXXXXX); chmod 755 "$SEC"
  BIN=$(jeval "$($CURL "$GW/_runner/download")" '(j.files.find(f=>f.platform==="linux-x64")||{}).name||""')
  r=$(jpost /api/aidev/targets "{\"name\":\"sec-check-$$\",\"description\":\"F-11 throw-away runner\",\"policy\":\"ask\"}"); STID=$(jeval "$r" 'j.target?.id||""'); SCODE=$(jeval "$r" 'j.target?.pairing_code||""')
  if [ -n "$BIN" ] && [ -n "$STID" ]; then
    $CURL "$GW/_runner/download/$BIN" > "$SEC/aidev-runner"; chmod 755 "$SEC/aidev-runner"
    RUN="docker run --rm --network $NET -v $SEC:/r -e AIDEV_RUNNER_HOME=/r/home node:22-bookworm-slim"
    $RUN /r/aidev-runner pair "$SCODE" --gateway "$GW" >/dev/null 2>&1
    docker run -d --name "aidev-sec-$$" --network "$NET" -v "$SEC:/r" -e AIDEV_RUNNER_HOME=/r/home node:22-bookworm-slim /r/aidev-runner start >/dev/null
    for i in $(seq 1 40); do [ "$(jeval "$(jget /api/aidev/targets)" "(j.targets.find(t=>t.id===$STID)||{}).online===true")" = true ] && break; sleep 0.5; done
    r=$(jget /api/aidev/targets); check "$r" "(j.targets.find(t=>t.id===$STID)||{}).online===true" "F-11 throw-away runner $BIN online"
    r=$(jpost "/api/aidev/targets/$STID/screenshot" '{}'); check "$r" '/허용하지 않았습니다/.test(j.error)' "F-11 no screen consent → screen.shot refused"
    r=$(jget "/api/aidev/targets/$STID/windows"); check "$r" '/허용하지 않았습니다/.test(j.error)' "F-11 no screen consent → window list refused"
    r=$(jpost "/api/aidev/targets/$STID/devices/shot" '{}'); check "$r" '/허용하지 않았습니다/.test(j.error)' "F-11 no screen consent → device screenshot refused"
    t0=$(date +%s%N); jpost "/api/aidev/targets/$STID" '' DELETE >/dev/null
    code=$(timeout 15 docker wait "aidev-sec-$$" 2>/dev/null || echo timeout); ms=$(( ($(date +%s%N) - t0) / 1000000 ))
    check "{\"code\":\"$code\",\"ms\":$ms}" 'j.code==="3" && j.ms<10000' "F-11 deleted target: its runner is cut off and exits 3 (${ms}ms)"
    $RUN /r/aidev-runner start >/dev/null 2>&1 & SP=$!; sleep 6; if kill -0 $SP 2>/dev/null; then kill $SP; code=running; else wait $SP; code=$?; fi
    check "{\"code\":\"$code\"}" 'j.code==="3"' "F-11 revoked token no longer connects (exit $code)"
  else echo "FAIL F-11 throw-away runner (binary ${BIN:-none}, target ${STID:-none})"; fail=1; fi
  docker rm -f "aidev-sec-$$" >/dev/null 2>&1; [ -n "$STID" ] && jpost "/api/aidev/targets/$STID" '' DELETE >/dev/null 2>&1
  rm -rf "$SEC"
fi
if [ $backup -eq 1 ]; then echo "## db backup"; bash "$(dirname "$0")/db-backup.sh" run && bash "$(dirname "$0")/db-backup.sh" list; fi
if [ $experiments -eq 1 ]; then echo "## laya routing strategy experiments (A..E x 126 commands, ~5 min)"; docker exec aidev-laya python /srv/app/current/control/laya/bench/bench.py --experiments --out /models/bench 2>/tmp/bench-exp.err; grep -E "^\{\"strategy" /tmp/bench-exp.err; fi
if [ $bench -eq 1 ]; then echo "## laya benchmark (126 commands)"; docker exec aidev-laya python /srv/app/current/control/laya/bench/bench.py --out /models/bench 2>/tmp/bench.err | tail -40; grep -c MISS /tmp/bench.err | sed 's/^/misses: /'; fi
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
