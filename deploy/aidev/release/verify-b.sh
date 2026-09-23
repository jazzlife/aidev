#!/usr/bin/env bash
# Stage B server verification (IMPLEMENTATION-PLAN B-13 … B-17). Runs ON the AI-PC:
#   AIDEV_PASS=… verify-b.sh USERNAME [--bench] [--backup] [--experiments]   (or USERNAME PASSWORD …, legacy)
# Talks to the gateway over the proxy network exactly like the browser does, then reads
# container logs. Prints PASS/FAIL per check; exit 1 when any check fails.
set -uo pipefail
user=${1:?username}; shift
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then pass=$1; shift; else pass=${AIDEV_PASS:?password (AIDEV_PASS env or 2nd argument)}; fi
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
jget() { $CURL -H "authorization: Bearer $TOK" "$GW$1"; }
jpost() { $CURL -X "${3:-POST}" -H "authorization: Bearer $TOK" -H 'content-type: application/json' --data-binary "$2" "$GW$1"; }

echo "## release"
$CURL "$GW/_gateway/release"; echo
echo "## gateway log (seed / errors)"
docker logs --tail 50 aidev-auth-gateway 2>&1 | grep -E "seeded|gateway\]" | tail -5
echo "## accounts (engines column)"
docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js list 2>&1 | head -40

echo "## login as $user"
TOK=$($CURL -X POST -H 'content-type: application/json' --data-binary "{\"username\":\"$user\",\"password\":\"$pass\"}" "$GW/api/auth/login" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOK" ] || { echo "FAIL login"; exit 1; }
echo "PASS login"

r=$(jget /api/aidev/laya/health); check "$r" 'j.status==="ok" && j.device' "laya health ($(echo "$r" | sed -n 's/.*"device": *"\([^"]*\)".*/\1/p'))"
r=$(jget /api/aidev/agents); check "$r" 'j.agents.length>=13' "catalog seeded ($(echo "$r" | grep -o '"name"' | wc -l) agents)"
r=$(jget /api/aidev/engines); check "$r" 'j.engines && j.engines.claude && j.engines.codex' "engines: $(echo "$r" | cut -c1-200)"
r=$(jpost /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘"}'); check "$r" 'j.agent && j.decision_id>0' "route react → $(echo "$r" | sed -n 's/.*"agent":{"id":[0-9]*,"name":"\([^"]*\)".*/\1/p') fallback=$(echo "$r" | sed -n 's/.*"fallback":\([a-z]*\).*/\1/p') plan=$(echo "$r" | sed -n 's/.*"plan":{"engine":\("[^"]*"\|null\),"engine_locked":[a-z]*,"model":\("[^"]*"\|null\),"effort":\("[^"]*"\|null\).*/\1 \2 \3/p') laya_ms=$(echo "$r" | sed -n 's/.*"latency_ms":\([0-9.]*\).*/\1/p')"
check "$r" 'j.agent.name==="frontend-react"' "route react picks frontend-react"
r=$(jpost /api/aidev/route '{"text":"이 로그 파일 5만 줄을 읽고 분석해서 오류 패턴을 요약해줘"}'); check "$r" 'j.scope.task_kind==="bulk_read"' "bulk_read recognised (task_kind=$(echo "$r" | sed -n 's/.*"task_kind":"\([^"]*\)".*/\1/p'), engine=$(echo "$r" | sed -n 's/.*"plan":{"engine":\("[^"]*"\|null\).*/\1/p'))"
r=$(jpost /api/aidev/route '{"text":"Unity 셰이더로 물 표면 굴절 효과를 구현해줘"}'); check "$r" 'j.decision' "unknown domain → decision=$(echo "$r" | sed -n 's/.*"decision":"\([^"]*\)".*/\1/p') needs_new=$(echo "$r" | sed -n 's/.*"needs_new":\([0-9.]*\).*/\1/p')"
r=$(jpost /api/aidev/decide/remote.approve '{"state":{"command":"rm -rf ~/projects && npm ci"}}'); check "$r" 'typeof j.answer==="number"' "decide remote.approve → $(echo "$r" | sed -n 's/.*"answer":\([0-9.]*\).*/\1/p')"
r=$(jpost /api/aidev/decide/agent.yesno '{"state":{"question":"Is the build green?","summary":"all 42 tests passed"}}'); check "$r" 'typeof j.answer==="number"' "decide agent.yesno → $(echo "$r" | sed -n 's/.*"answer":\([0-9.]*\).*/\1/p')"
r=$(jget "/api/aidev/decisions?limit=5"); check "$r" 'j.decisions.length>=3' "decision_log written"
echo "## routing eval on the held-out bench set (Laya-only vs lexical prior vs fused)"
r=$(jpost /api/aidev/route/eval '{}'); echo "$r" | cut -c1-600; echo "task_kind: $(echo "$r" | sed -n 's/.*"kind":{\([^}]*}\).*/\1/p' | cut -c1-400)"; check "$r" 'j.kind && j.kind.bulk_read_recall>=0.75' "task_kind fusion: bulk_read recall >= 0.75 (laya $(echo "$r" | sed -n 's/.*"kind":{[^}]*"laya_only":\([0-9.]*\).*/\1/p') nb $(echo "$r" | sed -n 's/.*"kind":{[^}]*"lexical_only":\([0-9.]*\).*/\1/p') fused $(echo "$r" | sed -n 's/.*"kind":{[^}]*"fused":\([0-9.]*\).*/\1/p') best α $(echo "$r" | sed -n 's/.*"kind":{[^}]*"best_alpha":\([0-9.]*\).*/\1/p'))"; check "$r" 'j.fused>=0.75' "fused routing accuracy >= 0.75 (laya $(echo "$r" | sed -n 's/.*"laya_only":\([0-9.]*\).*/\1/p') nb $(echo "$r" | sed -n 's/.*"lexical_only":\([0-9.]*\).*/\1/p') fused $(echo "$r" | sed -n 's/.*"fused":\([0-9.]*\).*/\1/p') best α $(echo "$r" | sed -n 's/.*"best_alpha":\([0-9.]*\).*/\1/p'))"

echo "## runtime logs: aidev routing applied (send a chat message first; B-13)"
for c in $(docker ps --format '{{.Names}}' | grep '^aidev-cloudcli-'); do
  n=$(docker logs --since 24h "$c" 2>&1 | grep -c "aidev routing"); echo "$c: $n routed turns"
  docker logs --since 24h "$c" 2>&1 | grep "aidev routing" | tail -3
done

if [ $backup -eq 1 ]; then echo "## db backup"; bash "$(dirname "$0")/db-backup.sh" run && bash "$(dirname "$0")/db-backup.sh" list; fi
if [ $experiments -eq 1 ]; then echo "## laya routing strategy experiments (A..E x 126 commands, ~5 min)"; docker exec aidev-laya python /srv/app/current/control/laya/bench/bench.py --experiments --out /models/bench 2>/tmp/bench-exp.err; grep -E "^\{\"strategy" /tmp/bench-exp.err; fi
if [ $bench -eq 1 ]; then echo "## laya benchmark (126 commands)"; docker exec aidev-laya python /srv/app/current/control/laya/bench/bench.py --out /models/bench 2>/tmp/bench.err | tail -40; grep -c MISS /tmp/bench.err | sed 's/^/misses: /'; fi
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
