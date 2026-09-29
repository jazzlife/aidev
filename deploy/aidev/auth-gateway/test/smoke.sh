#!/usr/bin/env bash
# Gateway smoke test against mock services (no AI-PC needed):
#   bash test/smoke.sh            -> builds, starts mocks + gateway on 18080, runs the checks, prints PASS/FAIL
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/dev/null
T=$(mktemp -d); trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/secrets"; head -c 48 /dev/urandom | base64 > "$T/secrets/jwt"; head -c 48 /dev/urandom | base64 > "$T/secrets/rt"
MOCK_CODEX_ONLY=rt-codexonly node test/mock-services.mjs >"$T/mock.log" 2>&1 &
sleep 0.5
export DATABASE_PATH="$T/auth.db" JWT_SECRET_FILE="$T/secrets/jwt" RUNTIME_MANAGER_TOKEN_FILE="$T/secrets/rt" \
  RUNTIME_MANAGER_URL=http://127.0.0.1:18090 LAYA_URL=http://127.0.0.1:18095 PUBLIC_ORIGIN=http://127.0.0.1:18080 PORT=18080 STATIC_ROOT="$T/dist" LAYA_RETRY_MS=1500
export RUNNER_DIST_DIR="$(cd .. && pwd)/runner/dist"
mkdir -p "$T/dist" "$T/dist-mobile"; echo '<html>workbench</html>' > "$T/dist/index.html"; echo '<html>mobile</html>' > "$T/dist-mobile/index.html"
# accounts: alice (both engines), bob (codex only, runtime rt-codexonly)
node -e "
const {openStore}=await import('./dist/store.js'); const s=openStore(process.env.DATABASE_PATH);
await s.add('alice','pw1234','rt-alice',1); await s.add('bob','pw1234','rt-codexonly',1); await s.add('admin','pw1234','rt-admin',1);
s.setAccountEngines('bob',['codex']); s.setRole('admin','admin'); s.db.close();" --input-type=module
node dist/auth-gateway.js >"$T/gw.log" 2>&1 & GWPID=$!
for i in $(seq 1 30); do curl -sf http://127.0.0.1:18080/_gateway/health >/dev/null && break; sleep 0.2; done
G=http://127.0.0.1:18080
login() { curl -s -X POST "$G/api/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"pw1234\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token'; }
A=$(login alice); B=$(login bob); ADM=$(login admin)
post() { curl -s -X "${4:-POST}" "$G$2" -H "authorization: Bearer $1" -H 'content-type: application/json' -d "$3"; }
get() { curl -s "$G$2" -H "authorization: Bearer $1"; }
fail=0; check() { if node -e "const j=JSON.parse(process.argv[1]); process.exit(($2)?0:1)" "$1"; then echo "PASS $3"; else echo "FAIL $3 :: $1" | cut -c1-400; fail=1; fi; }

r=$(get "$A" /api/aidev/laya/health); check "$r" 'j.status==="ok"' "laya health"
r=$(get "$A" /api/aidev/agents); check "$r" 'j.agents.length>=12 && j.agents.some(a=>a.name==="frontend-react")' "seeded agents ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).agents.length'))"
r=$(get "$A" /api/aidev/engines); check "$r" 'j.engines.claude.allowed && j.engines.claude.authenticated && j.engines.codex.authenticated' "engines alice both"
r=$(get "$B" /api/aidev/engines); check "$r" '!j.engines.claude.allowed && j.engines.codex.authenticated' "engines bob codex-only"
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘"}'); check "$r" 'j.agent.name==="frontend-react" && j.plan.engine && j.decision_id>0 && !j.fallback' "route react → frontend-react ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.plan.engine+" "+j.plan.model+"/"+j.plan.effort+" D"+j.scope.depth'))"
r=$(post "$A" /api/aidev/route '{"text":"이 로그 파일 5만 줄을 읽고 분석해서 오류 패턴을 요약해줘"}'); check "$r" 'j.scope.task_kind==="bulk_read" && j.plan.engine==="codex"' "bulk_read → codex (B-15)"
r=$(post "$B" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘"}'); check "$r" 'j.plan.engine==="codex" && j.engines.claude.score===null' "codex-only account never gets claude (B-14)"
r=$(post "$A" /api/aidev/route '{"text":"Unity 셰이더로 물 표면 굴절 효과를 구현해줘","sessionEngine":"claude"}'); check "$r" 'j.decision==="create" && j.plan.engine==="claude" && j.plan.engine_locked' "unknown domain → create; session engine locked"
r=$(post "$A" /api/aidev/route '{"text":"프로덕션 DB 테이블을 drop 하고 마이그레이션을 다시 돌려"}'); check "$r" 'j.scope.risk>=1.5 && j.scope.depth>=2' "risk raises depth"
r=$(post "$A" /api/aidev/decide/remote.approve '{"state":{"command":"rm -rf ~/projects/app/node_modules && npm ci"}}'); check "$r" 'typeof j.answer==="number" && j.decision_id>0' "decide remote.approve"
r=$(post "$A" /api/aidev/decide/agent.pick '{"state":{"command":"pick the fix","question":"Which fix is safest?"},"options":{"a":"add null check","b":"rewrite module","c":"delete the feature"}}'); check "$r" 'j.answer && j.kind==="agent.pick"' "decide agent.pick"
r=$(post "$A" /api/aidev/decide/bogus '{"state":{}}'); check "$r" 'j.error' "unknown kind rejected"
DID=$(post "$A" /api/aidev/route '{"text":"Express API에 rate limit 미들웨어 추가"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).decision_id')
r=$(post "$A" /api/aidev/runs "{\"decision_id\":$DID,\"session_id\":\"s1\",\"engine\":\"claude\",\"model\":\"sonnet\",\"effort\":\"high\",\"agent_id\":1,\"depth\":2,\"task_kind\":\"implement\"}"); RID=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run_id'); check "$r" 'j.run_id>0' "run created"
r=$(post "$A" "/api/aidev/runs/$RID/outcome" '{"exit_code":0,"test_result":"pass"}' PATCH); check "$r" 'j.run.outcome==="success"' "run outcome success"
r=$(post "$A" "/api/aidev/runs/$RID/outcome" '{"user_feedback":"down"}' PATCH); check "$r" 'j.run.outcome==="fail" && j.next && ["retry_same","escalate_tier","switch_engine","ask_user"].includes(j.next.action) && j.next.from_run>0' "run outcome fail after 👎 → next step ($(echo "$r" | node -pe 'const n=JSON.parse(require("fs").readFileSync(0)).next||{}; n.action+" "+(n.engine||"")+" "+(n.model||"")'))"
r=$(post "$A" "/api/aidev/runs" "{\"decision_id\":$DID,\"session_id\":\"s1\",\"engine\":\"claude\",\"model\":\"opus\",\"effort\":\"high\",\"agent_id\":1,\"depth\":3,\"escalated_from_run\":$RID}"); RID2=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run_id')
r=$(post "$A" "/api/aidev/runs/$RID2/outcome" '{"exit_code":1}' PATCH); check "$r" 'j.run.outcome==="fail" && j.next && j.next.chain===1' "escalated retry failing again → chain 1 ($(echo "$r" | node -pe 'const n=JSON.parse(require("fs").readFileSync(0)).next||{}; n.action+" "+(n.model||"")'))"
# E-05: learned tier policy — admin pins the cell a command routes to, routing follows; pass + log
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","preferEngine":"claude"}'); TD=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).scope.depth'); TDOM=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).agent.domain')
r=$(post "$A" /api/aidev/tier-policy "{\"domain\":\"$TDOM\",\"depth\":$TD,\"engine\":\"claude\",\"level\":4,\"pinned\":true}" PUT); check "$r" 'j.error' "tier policy edit is admin only"
r=$(post "$ADM" /api/aidev/tier-policy "{\"domain\":\"$TDOM\",\"depth\":$TD,\"engine\":\"claude\",\"level\":4,\"pinned\":true}" PUT); check "$r" 'j.cell.level===4 && j.cell.model==="best" && j.cell.pinned===1' "admin pins $TDOM D$TD claude → D4"
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","preferEngine":"claude"}'); check "$r" 'j.plan.model==="best" && j.plan.effort==="xhigh"' "routing follows the tier policy ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.plan.model+"/"+j.plan.effort'))"
r=$(post "$A" /api/aidev/settings/effort-cap '{"claude":"max","codex":"ultra"}' PUT); check "$r" 'j.effort_cap.claude==="max" && j.effort_cap.codex==="ultra"' "effort ceiling saved"
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","preferEngine":"claude"}'); check "$r" 'j.plan.model==="best" && j.plan.effort==="max"' "top tier runs at the ceiling ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.plan.model+"/"+j.plan.effort'))"
r=$(post "$A" /api/aidev/settings/effort-cap '{"claude":"high"}' PUT); r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","preferEngine":"claude"}'); check "$r" 'j.plan.effort==="high"' "lower ceiling caps the top tier ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).plan.effort'))"
r=$(post "$A" /api/aidev/settings/effort-cap '{"claude":"ultra"}' PUT); check "$r" 'j.error' "claude has no ultra"
r=$(get "$A" /api/aidev/engines); check "$r" 'j.effort_cap.claude==="high" && j.effort_ladder.codex.includes("ultra")' "engines report ceiling + ladder"
post "$A" /api/aidev/settings/effort-cap '{"claude":"xhigh","codex":"xhigh"}' PUT >/dev/null
# chat-level ceiling: sent with a new chat's first message, stored per session afterwards; the account default stays
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","preferEngine":"claude","effortCap":{"claude":"low"}}'); check "$r" 'j.plan.effort==="low"' "new chat: its own ceiling applies (low)"
r=$(post "$A" /api/aidev/session-settings/s-cap '{"claude":"medium"}' PUT); check "$r" 'j.effort_cap.claude==="medium" && j.default.claude==="xhigh" && j.effective.claude==="medium" && j.effective.codex==="xhigh"' "chat ceiling stored for the session, default untouched"
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","preferEngine":"claude","sessionId":"s-cap"}'); check "$r" '["low","medium"].includes(j.plan.effort)' "that chat routes under its ceiling ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).plan.effort'))"
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","preferEngine":"claude","sessionId":"other"}'); check "$r" '!["low","medium"].includes(j.plan.effort)' "other chats keep the default ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).plan.effort'))"
r=$(post "$A" /api/aidev/session-settings/s-cap '{"claude":"ultra"}' PUT); check "$r" 'j.error' "chat ceiling validated"
r=$(get "$B" /api/aidev/session-settings/s-cap); check "$r" 'j.effort_cap===null' "another user does not see the chat ceiling"
r=$(post "$A" /api/aidev/session-settings/s-cap '{}' DELETE); check "$r" 'j.effort_cap===null && j.effective.claude==="xhigh"' "chat ceiling reset → default"

r=$(get "$ADM" /api/aidev/tier-policy); check "$r" 'j.downgrade===false' "tier downgrades off by default (quality first)"
r=$(post "$ADM" /api/aidev/tier-policy/settings '{"downgrade":true}' PUT); check "$r" 'j.downgrade===true' "admin turns downgrades on"
r=$(post "$A" /api/aidev/tier-policy/settings '{"downgrade":false}' PUT); check "$r" 'j.error' "downgrade setting is admin only"
post "$ADM" /api/aidev/tier-policy/settings '{"downgrade":false}' PUT >/dev/null
r=$(get "$A" /api/aidev/agents); check "$r" 'j.agents.find(a=>a.name==="security-review").minTier===3 && j.agents.find(a=>a.name==="frontend-react").minTier===null' "seeded specialist floors (security-review ≥ D3)"
r=$(post "$ADM" /api/aidev/tier-policy/run '{}'); check "$r" 'typeof j.cells==="number" && Array.isArray(j.changes)' "tier policy pass ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.cells+" cells, "+j.changes.length+" changes"'))"
r=$(get "$ADM" /api/aidev/tier-policy); check "$r" 'j.log.length>=1 && j.log[0].actor==="admin" && j.last_run>0' "tier policy log"
r=$(post "$ADM" /api/aidev/tier-policy "{\"domain\":\"$TDOM\",\"depth\":$TD,\"engine\":\"claude\",\"level\":null}" PUT); check "$r" 'j.cell.level===null && j.cell.model===null' "admin resets the cell"
r=$(post "$A" "/api/aidev/decisions/$DID" '{"final_agent":"backend-node","final_engine":"codex"}' PATCH); check "$r" 'j.ok' "decision override"
r=$(post "$A" /api/aidev/agents '{"name":"unity-shader","domain":"gamedev","description":"Unity shader and rendering: HLSL, ShaderLab, URP, VFX. 유니티 셰이더, 렌더링, 머티리얼.","prompt":"You are a Unity rendering engineer with deep ShaderLab/HLSL knowledge. Verify with a test scene.","knowledge":[{"title":"URP 17 shader API","body":"URP 17 (Unity 6) changed the Blit API; use Blitter.BlitCameraTexture.","source_url":"https://docs.unity3d.com/","source_date":"2026-01-10"}]}'); AID=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).agent.id'); check "$r" 'j.agent.name==="unity-shader" && j.agent.ownerId===1' "private agent created"
r=$(post "$A" /api/aidev/route '{"text":"Unity 셰이더로 물 표면 굴절 효과를 구현해줘"}'); check "$r" 'j.agent.name==="unity-shader" && j.decision==="use"' "new agent is routed to next time"
r=$(get "$A" "/api/aidev/knowledge?q=Blit"); check "$r" 'j.knowledge.length===1' "knowledge FTS search"
r=$(post "$A" "/api/aidev/agents/$AID" '{"prompt":"You are a Unity rendering engineer (v2). Always profile with the Frame Debugger before optimizing.","changelog":"add profiling rule"}' PUT); check "$r" 'j.version===2' "agent new version"
r=$(get "$A" "/api/aidev/agents/$AID"); check "$r" 'j.versions.length===2 && j.knowledge.length===1' "agent detail versions+knowledge"
r=$(get "$B" "/api/aidev/agents/$AID"); check "$r" 'j.error' "private agent hidden from other user"
# E-04: re-check a sourced item on the owner's runtime → Laya judges the replacement → old superseded
KID=$(get "$A" "/api/aidev/agents/$AID" | node -pe 'JSON.parse(require("fs").readFileSync(0)).knowledge[0].id')
r=$(post "$A" /api/aidev/knowledge/refresh "{\"id\":$KID}"); check "$r" 'j.job && j.job.total===1' "knowledge refresh started"
for i in 1 2 3 4 5 6 7 8 9 10; do r=$(get "$A" /api/aidev/knowledge/refresh); echo "$r" | grep -q '"running":false' && break; sleep 0.3; done
check "$r" 'j.job.done===1 && j.job.results[0].outcome==="superseded" && j.job.results[0].newId>0' "knowledge refresh: changed source → superseded ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.job.results.map(x=>x.outcome+" #"+x.newId).join()'))"
r=$(get "$A" "/api/aidev/agents/$AID"); check "$r" 'j.knowledge.length===1 && j.knowledge[0].title==="URP 17.1 shader API"' "agent now carries the refreshed item"
r=$(post "$B" /api/aidev/knowledge/refresh "{\"id\":$KID}"); check "$r" 'j.error' "someone else's knowledge cannot be refreshed"
r=$(post "$A" /api/aidev/lessons "{\"agent_id\":$AID,\"trigger\":\"shader compiles but renders black\",\"rule\":\"check the render queue and pass tags first\",\"status\":\"verified\"}"); check "$r" 'j.lesson.status==="verified"' "lesson added"
r=$(post "$A" /api/aidev/route '{"text":"Unity 셰이더로 물 표면 굴절 효과를 구현해줘"}'); check "$r" 'j.lessons.length===1' "verified lesson injected at D>=1"
r=$(post "$A" /api/aidev/targets '{"name":"mac-studio","platform":"macos","tags":["xcode","node"],"description":"개발용 맥 스튜디오"}'); check "$r" 'j.target.pairing_code.length===8' "target registered with pairing code"
r=$(post "$ADM" /api/aidev/route/eval '{"rows":[{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","agent":"frontend-react","lang":"ko"},{"text":"Write a migration adding a unique index on (user_id, name)","agent":"database","lang":"en"},{"text":"docker compose에 헬스체크와 재시작 정책을 추가해줘","agent":"devops","lang":"ko"},{"text":"adb logcat에서 이 크래시 스택트레이스의 원인을 찾아줘","agent":"android-device","lang":"ko","task_kind":"debug"},{"text":"이 로그 파일 5만 줄을 읽고 분석해서 오류 패턴을 요약해줘","agent":"generalist","lang":"ko","task_kind":"bulk_read"},{"text":"Summarize every markdown file under docs/ and list the TODOs","agent":"generalist","lang":"en","task_kind":"bulk_read"}]}'); check "$r" 'j.n===6 && j.kind.n===3 && j.kind.examples>800 && j.kind.lexical_only>=0.66 && j.kind.bulk_read_recall===1' "route eval: task_kind prior (nb $(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.kind.lexical_only+" bulk_read recall "+j.kind.bulk_read_recall'))"; check "$r" 'j.n===6 && j.lexical_only>=0.5 && j.examples>800' "route eval: lexical prior $(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); "laya "+j.laya_only+" nb "+j.lexical_only+" fused "+j.fused+" best α "+j.best_alpha')"
r=$(get "$A" "/api/aidev/agents/2/examples"); check "$r" 'j.examples.length>=60' "seed examples per agent ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).examples.length'))"
r=$(get "$ADM" /api/aidev/stats); check "$r" 'j.decisions_24h.some(d=>d.kind==="route")' "admin stats"
r=$(get "$A" /api/aidev/stats); check "$r" 'j.error' "non-admin stats rejected"
r=$(curl -s "$G/api/aidev/export/decisions?kind=route" -H "authorization: Bearer $ADM" | head -1); check "$r" 'j.command && j.label' "export decisions JSONL"
r=$(curl -s -X POST "$G/internal/aidev/decide/agent.yesno" -H 'authorization: Bearer rtjwt-rt-alice' -H 'x-aidev-runtime: rt-alice' -H 'content-type: application/json' -d '{"state":{"question":"Is the build green?","summary":"tests pass ok"}}'); check "$r" 'j.kind==="agent.yesno" && j.decision_id>0' "runtime internal call (aidev-tools → gateway)"
r=$(curl -s -X POST "$G/internal/aidev/decide/agent.yesno" -H 'authorization: Bearer wrong' -H 'x-aidev-runtime: rt-alice' -H 'content-type: application/json' -d '{"state":{}}'); check "$r" 'j.error' "runtime internal call rejects bad token"
r=$(curl -s "$G/internal/aidev/targets" -H 'authorization: Bearer rtjwt-rt-alice' -H 'x-aidev-runtime: rt-alice'); check "$r" 'j.targets.length===1' "runtime lists user targets"
# two SPAs: /m/ → dist-mobile, phones redirected from /, cookie pins the choice
r=$(curl -s "$G/m/session/abc"); check "{\"body\":\"$r\"}" 'j.body.includes("mobile")' "/m/* serves the mobile app"
r=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'accept: text/html' -H 'user-agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1' "$G/session/abc"); check "{\"r\":\"$r\"}" 'j.r.startsWith("302 ") && j.r.endsWith("/m/session/abc")' "phone at / → 302 /m/<path>"
r=$(curl -s -H 'accept: text/html' -H 'user-agent: Mozilla/5.0 (iPhone) Mobile' -H "cookie: aidev_ui=workbench" "$G/"); check "{\"body\":\"$r\"}" 'j.body.includes("workbench")' "cookie aidev_ui=workbench keeps the workbench on a phone"
r=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H 'accept: text/html' -H 'user-agent: Mozilla/5.0 (Macintosh)' "$G/?ui=mobile"); check "{\"r\":\"$r\"}" 'j.r.startsWith("302 ") && j.r.endsWith("/m")' "?ui=mobile switches (sets cookie)"
r=$(curl -s -H 'accept: text/html' -H 'user-agent: Mozilla/5.0 (Macintosh)' "$G/"); check "{\"body\":\"$r\"}" 'j.body.includes("workbench")' "desktop at / gets the workbench"
# E-02: a relevant candidate rides along on trial, is recorded, and a successful run verifies it
AID=$(get "$A" /api/aidev/agents | node -pe 'JSON.parse(require("fs").readFileSync(0)).agents.find(a=>a.name==="frontend-react").id')
LID=$(post "$A" /api/aidev/lessons "{\"agent_id\":$AID,\"trigger\":\"React 컴포넌트에 토글 훅을 추가할 때\",\"rule\":\"훅 상태를 localStorage와 동기화한다\",\"status\":\"candidate\"}" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.lesson?.id ?? j.id')
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","sessionEngine":"claude"}'); check "$r" "j.lessons.some(l=>l.id===$LID && l.trial===true)" "lesson trial: relevant candidate #$LID carried on trial"
DID=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).decision_id')
RID=$(post "$A" /api/aidev/runs "{\"decision_id\":$DID,\"agent_id\":$AID,\"engine\":\"claude\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run_id')
post "$A" /api/aidev/runs/$RID/outcome '{"user_feedback":"up"}' PATCH >/dev/null
r=$(get "$A" /api/aidev/lessons?agent=$AID); check "$r" "j.lessons.some(l=>l.id===$LID && l.status==='verified' && l.verified_by==='auto' && l.hits===1)" "lesson trial: 👍 run verifies it (auto)"
r=$(post "$A" /api/aidev/route '{"text":"docker compose 헬스체크 추가해줘","sessionEngine":"claude"}'); check "$r" "!j.lessons.some(l=>l.trial)" "lesson trial: unrelated command carries no trial"
# Laya outage → fallback, service keeps answering
kill %1; sleep 0.3
r=$(post "$A" /api/aidev/route '{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘"}'); check "$r" 'j.fallback===true && j.agent.name==="frontend-react" && j.plan.engine' "laya down → lexical prior still routes (frontend-react), engine still chosen"
r=$(post "$A" /api/aidev/decide/ui.focus '{"state":{"event":"test failed"}}'); check "$r" 'j.fallback===true && j.answer==="none"' "laya down → kind fallback"
# web push (C-06): VAPID key, subscription validation, runtime login report
r=$(get "$A" /api/aidev/push/key); check "$r" 'typeof j.publicKey==="string" && j.publicKey.length>80' "push: VAPID public key"
r=$(post "$A" /api/aidev/push/subscribe '{"subscription":{"endpoint":"http://insecure.example/x","keys":{"p256dh":"a","auth":"b"}}}'); check "$r" 'j.error && /https/.test(j.error)' "push: non-https endpoint refused"
r=$(post "$A" /api/aidev/push/subscribe '{"subscription":{"endpoint":"https://push.example/abc","keys":{"p256dh":"BPk","auth":"x1"}}}'); check "$r" 'j.ok===true' "push: subscription stored"
r=$(post "$A" /api/aidev/claude-auth '{"expires_at":4102444800000}'); check "$r" 'j.ok===true' "claude-auth: expiry report accepted"
r=$(post "$A" /api/aidev/push/unsubscribe '{"endpoint":"https://push.example/abc"}'); check "$r" 'j.removed===1' "push: unsubscribe"
r=$(curl -s "$G/_runner/download"); if [ -d "$RUNNER_DIST_DIR" ]; then check "$r" 'j.files.length>=1 && j.files[0].sha256 && j.files[0].platform' "runner binaries listed ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).files.map(f=>f.platform).join(",")'))"
  F=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).files[0].name'); n=$(curl -s "$G/_runner/download/$F" | wc -c); check "{\"n\":$n,\"want\":$(stat -c %s "$RUNNER_DIST_DIR/$F")}" 'j.n===j.want' "runner binary download ($n bytes)"; fi
r=$(curl -s "$G/_runner/download/..%2F..%2Fetc%2Fpasswd" | grep -c "root:" || true); check "{\"c\":$r}" 'j.c===0' "download path traversal cannot read files"
# mocks back up (Laya + runtime manager) for the runner / gate checks
MOCK_CODEX_ONLY=rt-codexonly node test/mock-services.mjs >>"$T/mock.log" 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:18095/health && break; sleep 0.1; done; sleep 1.6   # past the gateway's Laya retry window
# F-02: remote PC runner — pairing, online state + capabilities, ping, ownership, re-pair and delete revoke it
RUNNER_BIN=${RUNNER_BIN:-$(cd .. && pwd)/runner/target/debug/aidev-runner}
if [ -x "$RUNNER_BIN" ]; then
  export AIDEV_RUNNER_HOME="$T/runner-home"; RH="$T/runner-user"; mkdir -p "$RH"
  r=$(post "$A" /api/aidev/targets '{"name":"dev-mac","description":"test PC","policy":"ask"}'); TID=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).target.id'); CODE=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).target.pairing_code')
  check "$r" 'j.target.id>0 && /^[0-9A-F]{8}$/.test(j.target.pairing_code)' "target registered with a pairing code"
  r=$(curl -s -X POST "$G/_runner/pair" -H 'content-type: application/json' -d '{"code":"ZZZZ9999"}'); check "$r" '/expired|not found/.test(j.error)' "unknown pairing code refused"
  r=$(curl -s -X POST "$G/_runner/pair" -H 'content-type: application/json' -H "origin: $G" -d "{\"code\":\"$CODE\"}"); check "$r" 'j.error' "pairing from a browser origin refused"
  HOME="$RH" "$RUNNER_BIN" pair "$(echo "$CODE" | tr A-Z a-z)" --gateway "$G" >/dev/null 2>&1; check "{\"ok\":$([ -f "$AIDEV_RUNNER_HOME/runner.toml" ] && echo true || echo false)}" 'j.ok' "runner paired with the code"
  r=$(curl -s -X POST "$G/_runner/pair" -H 'content-type: application/json' -d "{\"code\":\"$CODE\"}"); check "$r" 'j.error' "pairing code works once"
  HOME="$RH" "$RUNNER_BIN" start > "$T/runner1.log" 2>&1 & RPID=$!
  for i in $(seq 1 40); do r=$(get "$A" /api/aidev/targets); echo "$r" | grep -q '"online":true' && echo "$r" | grep -q '"hostname"' && break; sleep 0.25; done
  check "$r" "j.targets.find(t=>t.id===$TID).online && j.targets.find(t=>t.id===$TID).capabilities.os && j.targets.find(t=>t.id===$TID).paired && !('token_hash' in j.targets.find(t=>t.id===$TID) && j.targets.find(t=>t.id===$TID).token_hash)" "runner online with capabilities ($(echo "$r" | node -pe "const t=JSON.parse(require('fs').readFileSync(0)).targets.find(t=>t.id===$TID); t.capabilities.os+'/'+t.capabilities.arch+' tools '+Object.keys(t.capabilities.tools).length+' roots '+t.allowed_roots.length"))"
  r=$(post "$A" "/api/aidev/targets/$TID/ping" '{}'); check "$r" 'j.ok===true && j.result.pong===true && j.rtt_ms>=0' "ping through the hub ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).rtt_ms')ms)"
  r=$(post "$A" "/api/aidev/targets/$TID/refresh-caps" '{}'); check "$r" 'j.target.capabilities.runner' "capabilities refreshed on demand"
  r=$(post "$B" "/api/aidev/targets/$TID/ping" '{}'); check "$r" 'j.error' "another user cannot reach the target"
  # F-03: remote exec — piped output + exit code in remote_runs, log, roots, ownership, policy, browser stream, restart adoption
  waitrun() { for i in $(seq 1 ${2:-60}); do r=$(get "$A" "/api/aidev/remote-runs/$1"); echo "$r" | grep -q '"finished_at":[0-9]' && break; sleep 0.25; done; echo "$r"; }
  r=$(post "$A" "/api/aidev/targets/$TID/exec" '{"cmd":"echo hello-remote; echo oops 1>&2; pwd; exit 3"}'); RR=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  check "$r" 'j.stream.streamId>0 && j.stream.remoteRunId>0 && j.stream.running===true && j.stream.by==="user"' "exec started (stream $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.streamId'))"
  r=$(waitrun "$RR"); check "$r" 'j.run.exit_code===3 && j.run.approved_by==="user" && j.run.artifacts.bytes>0 && j.run.live && j.run.live.running===false' "exit code 3 recorded in remote_runs (bytes $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run.artifacts?.bytes'))"
  L=$(curl -s "$G/api/aidev/remote-runs/$RR/log?plain=1" -H "authorization: Bearer $A"); check "{\"ok\":$(echo "$L" | grep -q hello-remote && echo "$L" | grep -q oops && echo "$L" | grep -q runner-user && echo true || echo false)}" 'j.ok' "log has stdout + stderr, cwd = first allowed root"
  r=$(get "$A" "/api/aidev/targets/$TID/runs"); check "$r" "j.runs[0].id===$RR && j.runs[0].target_name==='dev-mac' && j.streams.length>=1" "runs listed per target"
  r=$(post "$A" "/api/aidev/targets/$TID/exec" '{"cmd":"ls","cwd":"/etc"}'); check "$r" '/허용된 폴더 밖/.test(j.error)' "cwd outside allowed_roots refused"
  r=$(post "$A" "/api/aidev/targets/$TID/exec" '{"cmd":"ls","env":{"BAD-NAME":"x"}}'); check "$r" 'j.error' "bad env name refused"
  r=$(post "$B" "/api/aidev/targets/$TID/exec" '{"cmd":"id"}'); check "$r" 'j.error' "another user cannot run commands on the target"
  r=$(get "$B" "/api/aidev/remote-runs/$RR"); check "$r" 'j.error' "another user cannot read the run"
  post "$A" "/api/aidev/targets/$TID" '{"policy":"deny"}' PATCH >/dev/null; r=$(post "$A" "/api/aidev/targets/$TID/exec" '{"cmd":"true"}'); check "$r" '/거부/.test(j.error)' "policy deny blocks exec"; post "$A" "/api/aidev/targets/$TID" '{"policy":"ask"}' PATCH >/dev/null
  r=$(node test/stream-client.mjs "$G" "$A" "$TID" || true); check "$r" 'j.hello && j.started && j.attached && j.echoed && j.sizeSeen && j.exit && j.exit.code!==0 && j.replay' "browser stream: pty input, resize, Ctrl+C, late viewer replay ($(echo "$r" | cut -c1-160))"
  r=$(curl -s -o /dev/null -w '%{http_code}' -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' -H "origin: http://evil.example" "$G/api/aidev/targets/$TID/stream?token=$A"); check "{\"code\":$r}" 'j.code===401' "stream socket from another origin refused"
  r=$(curl -s -o /dev/null -w '%{http_code}' -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' -H "origin: $G" "$G/api/aidev/targets/$TID/stream?token=$B"); check "{\"code\":$r}" 'j.code===401' "stream socket for someone else's target refused"
  # F-05: agent (runtime session) → gate: safe commands run, risky ones wait for the user, tests feed the chat run
  rpost() { curl -s -X POST "$G/internal/aidev$1" -H 'authorization: Bearer rtjwt-rt-alice' -H 'x-aidev-runtime: rt-alice' -H 'content-type: application/json' -d "$2"; }
  rget() { curl -s "$G/internal/aidev$1" -H 'authorization: Bearer rtjwt-rt-alice' -H 'x-aidev-runtime: rt-alice'; }
  mkdir -p "$RH/aidev-work"; echo '{"name":"t","scripts":{"test":"echo 3 passing"}}' > "$RH/aidev-work/package.json"
  RUN2=$(post "$A" /api/aidev/runs "{\"decision_id\":$DID,\"session_id\":\"s-remote\",\"engine\":\"claude\",\"model\":\"sonnet\",\"effort\":\"high\",\"agent_id\":1,\"depth\":2,\"task_kind\":\"implement\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run_id')
  r=$(rpost "/targets/$TID/exec" "{\"cmd\":\"npm test\",\"runId\":$RUN2,\"agent\":\"testing\"}"); RR3=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  check "$r" 'j.status==="started" && j.stream.by==="auto" && j.assessment.safe===true' "agent: test command runs without asking (policy ask, risk $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).assessment?.risk'))"
  r=$(rget "/remote-runs/$RR3/wait?timeout=20"); check "$r" 'j.run.exit_code===0 && /3 passing/.test(j.output) && j.run.run_id>0' "agent: waits for the result (exit 0, output returned)"
  r=$(get "$A" "/api/aidev/runs?limit=5"); check "$r" "(j.runs||[]).some(x=>x.id===$RUN2 && x.test_result==='pass')" "remote test result recorded on the chat run (test_result=pass)"
  r=$(rpost "/targets/$TID/exec" '{"cmd":"pwd","cwd":"~/aidev-work"}'); RR5=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  r=$(rget "/remote-runs/$RR5/wait?timeout=10"); check "$r" 'j.run.exit_code===0 && /aidev-work/.test(j.output)' "agent: cwd ~/aidev-work resolves on the target"
  r=$(rpost "/targets/$TID/exec" '{"cmd":"ls","cwd":"/definitely/not/here"}'); check "$r" 'j.status==="error" && /허용/.test(j.error) && Array.isArray(j.allowed_roots)' "agent: bad folder comes back as a result with the allowed roots"
  r=$(rpost "/targets/$TID/exec" '{"cmd":"rm -rf build-tmp && echo removed","agent":"testing"}'); AP=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).approval?.id')
  check "$r" 'j.status==="pending" && j.approval.destructive && j.approval.reasons.length>0' "agent: rm -rf waits for approval ($(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).approval?.reasons.join(", ")'))"
  r=$(get "$A" /api/aidev/approvals); check "$r" "j.approvals.some(a=>a.id==='$AP')" "user sees the pending approval"
  r=$(get "$B" /api/aidev/approvals); check "$r" "!j.approvals.some(a=>a.id==='$AP')" "another user does not"
  r=$(rpost "/approvals/$AP" '{"allow":true}'); check "$r" '/answered by the user/.test(j.error)' "an agent cannot approve its own command"
  (sleep 1; post "$A" "/api/aidev/approvals/$AP" '{"allow":true}' >/dev/null) &
  r=$(rget "/approvals/$AP/wait?timeout=10"); RR4=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).approval?.remoteRunId')
  check "$r" 'j.approval.status==="allowed" && j.approval.remoteRunId>0 && j.approval.decidedBy==="user"' "agent's long-poll returns when the user allows"
  r=$(rget "/remote-runs/$RR4/wait?timeout=20"); check "$r" 'j.run.exit_code===0 && j.run.approved_by==="user" && /removed/.test(j.output)' "approved command ran (approved_by=user)"
  r=$(rpost "/targets/$TID/exec" '{"cmd":"sudo ls","agent":"testing"}'); AP2=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).approval?.id')
  r=$(post "$A" "/api/aidev/approvals/$AP2" '{"allow":false}'); check "$r" 'j.approval.status==="denied" && j.approval.remoteRunId>0' "user denies sudo → recorded"
  r=$(get "$A" "/api/aidev/remote-runs/$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).approval.remoteRunId')"); check "$r" 'j.run.approved_by==="denied" && j.run.finished_at>0' "denied command is a remote_runs row (approved_by=denied)"
  r=$(rpost "/targets/$TID/exec" '{"cmd":"touch made-by-agent.txt"}'); check "$r" 'j.status==="pending"' "policy ask: file-changing command asks"
  post "$A" "/api/aidev/approvals/$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).approval.id')" '{"allow":true,"auto":true}' >/dev/null
  r=$(get "$A" /api/aidev/targets); check "$r" "j.targets.find(t=>t.id===$TID).policy==='auto'" "\"allow + auto\" switches the target to policy auto"
  r=$(rpost "/targets/$TID/exec" '{"cmd":"touch second.txt"}'); check "$r" 'j.status==="started" && j.stream.by==="auto"' "policy auto: moderate command runs without asking"
  r=$(rpost "/targets/$TID/exec" '{"cmd":"git push --force origin main"}'); check "$r" 'j.status==="pending"' "policy auto: destructive command still asks"
  post "$A" "/api/aidev/targets/$TID" '{"policy":"deny"}' PATCH >/dev/null; r=$(rpost "/targets/$TID/exec" '{"cmd":"ls"}'); check "$r" 'j.status==="denied" && /실행 금지/.test(j.reason)' "policy deny: agent refused"; post "$A" "/api/aidev/targets/$TID" '{"policy":"ask"}' PATCH >/dev/null
  # F-04: sync through the gateway RPC (runtime session): manifest → write → delete, report, policy
  r=$(rpost "/targets/$TID/rpc" '{"method":"sync.write","params":{"root":"~/aidev-work/proj","files":[{"path":"src/a.txt","b64":"aGVsbG8="},{"path":"b.txt","b64":"Yg=="}]}}'); check "$r" 'j.result.written===2' "sync.write through the gateway (~ root resolved)"
  r=$(rpost "/targets/$TID/rpc" '{"method":"sync.manifest","params":{"root":"~/aidev-work/proj"}}'); check "$r" 'j.result.exists && j.result.files.length===2 && j.result.files.every(f=>f.synced && f.sha256.length===64)' "sync.manifest lists synced files with sha256"
  r=$(rpost "/targets/$TID/rpc" '{"method":"sync.delete","params":{"root":"~/aidev-work/proj","paths":["b.txt"]}}'); check "$r" 'j.result.deleted===1' "sync.delete removes a synced file"
  r=$(rpost "/targets/$TID/rpc" '{"method":"exec.start","params":{"cmd":"id"}}'); check "$r" '/not allowed/.test(j.error)' "rpc endpoint only allows sync/fs methods"
  r=$(rpost "/targets/$TID/rpc" '{"method":"sync.manifest","params":{"root":"~/aidev-work"}}'); check "$r" '/하위 폴더/.test(j.error)' "the allowed root itself is not a sync destination"
  r=$(rpost "/targets/$TID/sync-report" '{"dest":"/x/proj","project":"proj","uploaded":2,"deleted":1,"unchanged":0,"bytes":6,"ms":12}'); check "$r" 'j.remoteRunId>0' "sync report recorded as a remote run"
  r=$(get "$A" "/api/aidev/remote-runs/$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).remoteRunId')"); check "$r" 'j.run.kind==="sync" && j.run.artifacts.uploaded===2 && j.run.exit_code===0' "sync run visible to the user"
  post "$A" "/api/aidev/targets/$TID" '{"policy":"deny"}' PATCH >/dev/null; r=$(rpost "/targets/$TID/rpc" '{"method":"sync.write","params":{"root":"~/aidev-work/proj","files":[]}}'); check "$r" '/실행 금지/.test(j.error)' "policy deny blocks sync writes"; post "$A" "/api/aidev/targets/$TID" '{"policy":"ask"}' PATCH >/dev/null
  # a command outlives a gateway restart: the runner keeps it, the new gateway adopts it by tag and catches up the output
  r=$(post "$A" "/api/aidev/targets/$TID/exec" '{"cmd":"echo before; sleep 3; echo after-restart; exit 5"}'); RR2=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  sleep 0.5; kill "$GWPID"; sleep 0.5
  node dist/auth-gateway.js >>"$T/gw.log" 2>&1 & GWPID=$!
  for i in $(seq 1 30); do curl -sf "$G/_gateway/health" >/dev/null && break; sleep 0.2; done
  r=$(waitrun "$RR2" 120); L=$(curl -s "$G/api/aidev/remote-runs/$RR2/log?plain=1" -H "authorization: Bearer $A")
  check "$r" "j.run.exit_code===5 && $(echo "$L" | grep -q after-restart && echo true || echo false)" "run survives a gateway restart (adopted, exit 5, output caught up)"
  r=$(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer '"$(printf 'c%.0s' $(seq 1 64))" -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' "$G/_runner/ws"); check "{\"code\":$r}" 'j.code===401' "runner socket with a wrong token refused"
  # re-pair: a new code, paired again → the old connection is cut (4401) and that runner exits 3
  CODE2=$(post "$A" "/api/aidev/targets/$TID/pair/refresh" '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).pairing_code')
  cp "$AIDEV_RUNNER_HOME/runner.toml" "$T/old-runner.toml"
  HOME="$RH" "$RUNNER_BIN" pair "$CODE2" --gateway "$G" >/dev/null 2>&1 || true
  for i in $(seq 1 40); do kill -0 $RPID 2>/dev/null || break; sleep 0.25; done; code=0; wait $RPID || code=$?
  check "{\"code\":$code}" 'j.code===3' "re-pairing revokes the old runner (exit 3)"
  HOME="$RH" "$RUNNER_BIN" start > "$T/runner2.log" 2>&1 & RPID=$!
  for i in $(seq 1 40); do get "$A" /api/aidev/targets | grep -q '"online":true' && break; sleep 0.25; done
  r=$(post "$A" "/api/aidev/targets/$TID" '{}' DELETE); check "$r" 'j.ok' "target deleted"
  for i in $(seq 1 40); do kill -0 $RPID 2>/dev/null || break; sleep 0.25; done; code=0; wait $RPID || code=$?
  check "{\"code\":$code}" 'j.code===3' "deleting the target disconnects the runner (exit 3)"
  cp "$T/old-runner.toml" "$AIDEV_RUNNER_HOME/runner.toml"; code=0; HOME="$RH" timeout 10 "$RUNNER_BIN" start >/dev/null 2>&1 || code=$?
  check "{\"code\":$code}" 'j.code===3' "old token no longer connects"
  unset AIDEV_RUNNER_HOME
else echo "SKIP runner checks (build deploy/aidev/runner first: cargo build)"; fi
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "--- gateway log"; tail -20 "$T/gw.log"; exit 1; }
