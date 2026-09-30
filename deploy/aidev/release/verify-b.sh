#!/usr/bin/env bash
# Stage B server verification (IMPLEMENTATION-PLAN B-13 … B-17). Runs ON the AI-PC:
#   verify-b.sh USERNAME [--bench] [--backup] [--experiments]
#     no password: a 10-minute gateway session is minted inside the gateway container
#     (manage-users session) and revoked at the end — nothing is typed or leaves the AI-PC.
#   AIDEV_PASS=… verify-b.sh USERNAME …   (or USERNAME PASSWORD …, legacy) logs in like the browser
# Talks to the gateway over the proxy network exactly like the browser does, then reads
# container logs. Prints PASS/FAIL per check; exit 1 when any check fails.
set -uo pipefail
user=${1:?username}; shift
pass=""; if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then pass=$1; shift; else pass=${AIDEV_PASS:-}; fi
bench=0; backup=0; experiments=0; for a in "$@"; do case "$a" in --bench) bench=1;; --backup) backup=1;; --experiments) experiments=1;; esac; done
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

if [ $backup -eq 1 ]; then echo "## db backup"; bash "$(dirname "$0")/db-backup.sh" run && bash "$(dirname "$0")/db-backup.sh" list; fi
if [ $experiments -eq 1 ]; then echo "## laya routing strategy experiments (A..E x 126 commands, ~5 min)"; docker exec aidev-laya python /srv/app/current/control/laya/bench/bench.py --experiments --out /models/bench 2>/tmp/bench-exp.err; grep -E "^\{\"strategy" /tmp/bench-exp.err; fi
if [ $bench -eq 1 ]; then echo "## laya benchmark (126 commands)"; docker exec aidev-laya python /srv/app/current/control/laya/bench/bench.py --out /models/bench 2>/tmp/bench.err | tail -40; grep -c MISS /tmp/bench.err | sed 's/^/misses: /'; fi
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
