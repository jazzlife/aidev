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
  RUNTIME_MANAGER_URL=http://127.0.0.1:18090 LAYA_URL=http://127.0.0.1:18095 PUBLIC_ORIGIN=http://127.0.0.1:18080 PORT=18080 STATIC_ROOT="$T/dist" LAYA_RETRY_MS=1500 AIDEV_JUDGE_WAIT_MS=1500
# what the release serves under /_runner/: binaries, adapters, per-OS scripts, runner source (runner/scripts/stage-dist.sh)
"$(cd .. && pwd)/runner/scripts/stage-dist.sh" "$T/runner"; export RUNNER_DIST_DIR="$T/runner"
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
# specialist judge: only a true specialist is used; otherwise create (with a proposal) — the ranker's pick does not win by default
# (D-04: the mock scores these commands D0–1, so they run on the generalist and queue the domain — create_background)
r=$(post "$A" /api/aidev/route '{"text":"Verilog로 UART 송신기 모듈을 작성해줘"}'); check "$r" '/^create/.test(j.decision) && j.create && j.create.proposal && j.create.proposal.name==="fpga-verilog" && j.judge.source==="llm"' "no specialist → create with the judge's proposal (fpga-verilog)"
r=$(post "$A" /api/aidev/route '{"text":"SwiftUI로 iOS 위젯 만들어줘"}'); check "$r" '/^create/.test(j.decision) && j.agent.name!=="frontend-react"' "near miss (SwiftUI ≠ React) is not used"
r=$(post "$A" /api/aidev/route '{"text":"Verilog로 UART 송신기 모듈을 작성해줘"}'); check "$r" 'j.judge.source==="cache" && /^create/.test(j.decision)' "same command → cached verdict (no second LLM turn)"
# typing-time pre-judge: the send joins the running judge call (one LLM turn), a repeat is served from the cache
r=$(post "$A" /api/aidev/route/prejudge '{"text":"Blender 애드온 만들어줘 slow-judge-800"}'); check "$r" 'j.status==="started"' "prejudge starts the judge while typing"
r=$(post "$A" /api/aidev/route/prejudge '{"text":"Blender 애드온 만들어줘 slow-judge-800"}'); check "$r" 'j.status==="running"' "a second pause joins the running judge"
r=$(post "$A" /api/aidev/route '{"text":"Blender 애드온 만들어줘 slow-judge-800"}'); check "$r" 'j.judge && j.judge.source==="llm" && j.judge.prejudged===true && /^create/.test(j.decision) && j.create.proposal.name==="blender-addon"' "send joins the pre-judge (waited $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).judge?.wait_ms')ms)"
r=$(post "$A" /api/aidev/route/prejudge '{"text":"blender 애드온   만들어줘 slow-judge-800"}'); check "$r" 'j.status==="cached"' "prejudge of the same command (normalized) → cached"
r=$(post "$A" /api/aidev/route/prejudge '{"text":"hi"}'); check "$r" 'j.status==="skipped"' "too short → skipped"
# a judge slower than the send's wait: the send falls back, the verdict lands in the cache for the next send
r=$(post "$A" /api/aidev/route '{"text":"Verilog 테스트벤치 작성 slow-judge-2500"}'); check "$r" '!j.judge && j.plan.reason.some(x=>/still running/.test(x))' "judge slower than AIDEV_JUDGE_WAIT_MS → fallback, not blocked"
sleep 1.3
r=$(post "$A" /api/aidev/route '{"text":"Verilog 테스트벤치 작성 slow-judge-2500"}'); check "$r" 'j.judge && j.judge.source==="cache" && /^create/.test(j.decision)' "late verdict was cached → next send uses it"
r=$(post "$A" /api/aidev/route '{"text":"이 함수 이름을 더 명확하게 바꿔줘"}'); check "$r" 'j.decision==="generalist" && j.agent.name==="generalist"' "trivial request → generalist"
# D-04 create queue: the quick unknown-domain commands above were queued; dismiss one; accept via createProposal
r=$(get "$A" /api/aidev/create-queue); check "$r" 'j.entries.length>=1 && j.entries.every((e)=>e.count>=1 && Array.isArray(e.commands))' "create queue lists the queued domains ($(echo "$r" | grep -o '"name":"[^"]*"' | head -3 | tr '\n' ' '))"
CQ=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).entries[0].id')
r=$(post "$A" /api/aidev/route "{\"text\":\"[전문 agent 만들기]\",\"createProposal\":$CQ}"); check "$r" 'j.decision==="create" && j.create.from_queue===true && j.create.queue && j.create.proposal' "accepting a queued domain routes to the architect"
r=$(post "$A" "/api/aidev/create-queue/$CQ" '{"status":"dismissed"}' PATCH); check "$r" 'j.changed===1' "a queued domain can be dismissed"
r=$(get "$A" /api/aidev/create-queue); check "$r" "!j.entries.some((e)=>e.id===$CQ)" "a dismissed domain leaves the list"
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
  F=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).files[0].name'); n=$(curl -s "$G/_runner/download/$F" | wc -c); check "{\"n\":$n,\"want\":$(wc -c < "$RUNNER_DIST_DIR/$F" | tr -d ' ')}" 'j.n===j.want' "runner binary download ($n bytes)"; fi
r=$(curl -s "$G/_runner/download/..%2F..%2Fetc%2Fpasswd" | grep -c "root:" || true); check "{\"c\":$r}" 'j.c===0' "download path traversal cannot read files"
# F-09b: platform-built debug adapters (aidev-clrdbg) listed and served with the SHA-256 the runner checks
if [ -f "$RUNNER_DIST_DIR/adapters/manifest.json" ]; then
  r=$(curl -s "$G/_runner/adapters/manifest.json"); check "$r" 'j["clrdbg-win32-x64"] && j["clrdbg-win32-x64"].sha256.length===64' "adapter manifest lists clrdbg"
  F=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0))["clrdbg-win32-x64"].file'); W=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0))["clrdbg-win32-x64"].sha256')
  h=$(curl -s "$G/_runner/adapters/$F" | sha256sum | cut -d' ' -f1); check "{\"ok\":$([ "$h" = "$W" ] && echo true || echo false)}" 'j.ok' "adapter archive download matches its SHA-256"
fi
c=$(curl -s "$G/_runner/adapters/..%2F..%2Fauth.db" | grep -ac "SQLite format" || true); check "{\"c\":$c}" 'j.c===0' "adapter path traversal cannot read files"
# per-OS install/build scripts and the runner source, served for PCs to install or build the runner
for f in scripts/install-linux.sh scripts/install-macos.sh scripts/install-windows.ps1 scripts/build-linux.sh scripts/build-macos.sh scripts/build-windows.ps1; do
  h=$(curl -s -o /dev/null -w '%{http_code}' "$G/_runner/$f"); check "{\"h\":$h}" 'j.h===200' "served: /_runner/$f"
done
n=$(curl -s "$G/_runner/source/aidev-runner-src.tar.gz" | tar -tz 2>/dev/null | grep -cE '^aidev-runner-src/(Cargo.toml|src/main.rs|scripts/build-linux.sh|assets/aidev-jdi/aidev-jdi.jar)$' || true); check "{\"n\":$n}" 'j.n===4' "runner source tarball (Cargo.toml, src, scripts, embedded JVM adapter)"
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
  # an old copy of the runner with the same token must not take the connection from the newer one
  RTOK=$(sed -n 's/^token = "\(.*\)"/\1/p' "$AIDEV_RUNNER_HOME/runner.toml")
  r=$(node -e "
    const { WebSocket } = require('ws'); const ws = new WebSocket(process.argv[1].replace(/^http/, 'ws') + '/_runner/ws', { headers: { authorization: 'Bearer ' + process.argv[2], 'x-aidev-runner': '0.3.0' } });
    ws.on('unexpected-response', (_q, res) => { console.log(JSON.stringify({ status: res.statusCode })); process.exit(0); });
    ws.on('open', () => { console.log(JSON.stringify({ status: 101 })); process.exit(0); });
    ws.on('error', (e) => { console.log(JSON.stringify({ error: e.message })); process.exit(0); });" "$G" "$RTOK")
  sleep 0.3; r2=$(get "$A" /api/aidev/targets)
  check "{\"dup\":$r,\"targets\":$r2}" "j.dup.status===409 && j.targets.targets.find(t=>t.id===$TID).online" "an older runner with the same token is refused (409), the newer one stays connected"
  # the workbench pairing card's commands, pasted into bash (Linux), interactive zsh (macOS) and PowerShell (Windows)
  if [ "$(uname -s)" = Linux ] && [ -d "$RUNNER_DIST_DIR" ] && command -v zsh >/dev/null; then
    PC=$(PWSH="${PWSH:-$(command -v pwsh || true)}" bash test/pairing-commands.sh "$G" "$A" "$T/paste" 2>"$T/paste.err")
    r=$(echo "$PC" | grep '"shell":"bash"'); check "${r:-null}" 'j.exitCode===0 && j.exe && j.paired && j.serviceStarted && j.unitPointsAtFixedPath' "pairing card, Linux (bash): download to ~/.aidev/bin, pair, service points at that file ($r)"
    r=$(echo "$PC" | grep '"shell":"zsh"'); check "${r:-null}" 'j.paired && j.serviceStarted && j.unitPointsAtFixedPath' "pairing card, macOS (interactive zsh, no comment words): pair + install-service as pasted"
    r=$(echo "$PC" | grep 'zsh-comment-check'); check "${r:-null}" 'j.commentIsWord===true' "(why: a trailing # comment is an argument in interactive zsh)"
    r=$(echo "$PC" | grep '"shell":"powershell"'); if echo "$r" | grep -q skipped; then echo "SKIP pairing card, Windows (no pwsh)"; else
      check "${r:-null}" 'j.parseErrors===0 && j.binDir && /curl -fsSL http:\/\/127\.0\.0\.1:18080\/_runner\/download\/aidev-runner-0\.7\.0-win-x64\.exe -o /.test(j.curl) && j.curl.endsWith(j.home+"\\.aidev\\bin\\aidev-runner.exe") && j.runner.length===2 && j.runner[0]===j.home+"\\.aidev\\bin\\aidev-runner.exe pair CODE1234 --gateway http://127.0.0.1:18080" && j.runner[1].endsWith("aidev-runner.exe install-service")' "pairing card, Windows (PowerShell): parses, folder made, curl.exe to %USERPROFILE%\\.aidev\\bin, runner called with pair/install-service ($(echo "$r" | cut -c1-200))"; fi
  else echo "SKIP pairing card commands (needs Linux, runner dist + zsh)"; fi
  # the per-OS install scripts from the gateway, run for real (Linux; the Windows script in PowerShell test mode)
  if [ "$(uname -s)" = Linux ]; then
  IS=$(PWSH="${PWSH:-$(command -v pwsh || true)}" bash test/install-scripts.sh "$G" "$A" "$T/install" 2>"$T/install.err")
  r=$(echo "$IS" | grep '"case":"linux"'); check "${r:-null}" 'j.exit===0 && j.downloaded && j.exe && j.paired && j.connected && j.online && j.stoppedAfterUninstall' "install-linux.sh via curl|bash: download (SHA-256), pair, keep running, connected → online, --uninstall stops it"
  r=$(echo "$IS" | grep '"case":"windows-ps1"'); if echo "$r" | grep -q skipped; then echo "SKIP install-windows.ps1 (no pwsh)"; else
    check "${r:-null}" 'j.exit===0 && j.exe && j.paired' "install-windows.ps1 via irm (PowerShell, test mode): installs to .aidev\\bin, pairs ($(echo "$r" | cut -c1-160))"; fi
  else echo "SKIP install scripts run for real (needs Linux: they install the linux-x64 runner)"; fi
  r=$(post "$B" "/api/aidev/targets/$TID/ping" '{}'); check "$r" 'j.error' "another user cannot reach the target"
  # F-08: which PC a command goes to — named in the command, chat pin, account default; remote_action from Laya + lexical prior
  r=$(post "$A" /api/aidev/route '{"text":"dev-mac에서 이 코드 한번 봐줘"}'); check "$r" 'j.plan.target && j.plan.target.name==="dev-mac" && j.plan.target.source==="mention" && j.scope.remote_action!=="none" && j.targets.length===1' "F-08: a PC named in the command gets the work ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.scope.remote_action+" on "+j.plan.target?.name+" ("+j.plan.target?.source+")"'))"
  r=$(post "$A" /api/aidev/route '{"text":"이 함수 이름을 더 명확하게 바꿔줘"}'); check "$r" 'j.scope.remote_action==="none" && !j.plan.target && j.targets.length===1' "F-08: code work stays in the cloud (remote none, $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).scope.remote_action_probability?.toFixed(2)'))"
  post "$A" "/api/aidev/targets/$TID" '{"default":true}' PATCH >/dev/null; r=$(get "$A" /api/aidev/targets); check "$r" "j.targets.find(t=>t.id===$TID).is_default===1" "F-08: default PC flag"
  r=$(post "$A" /api/aidev/session-settings/s-f08/target "{\"target_id\":$TID}" PUT); check "$r" "j.target_id===$TID" "F-08: chat pinned to the PC"
  r=$(post "$B" /api/aidev/session-settings/s-f08/target "{\"target_id\":$TID}" PUT); check "$r" 'j.error' "F-08: another user cannot pin my PC"
  r=$(get "$A" /api/aidev/session-settings/s-f08); check "$r" "j.target_id===$TID && j.effective" "F-08: session settings carry the pin"
  r=$(post "$A" /api/aidev/route '{"text":"내 맥에서 테스트 돌려서 결과 알려줘","sessionId":"s-f08"}'); check "$r" 'j.scope.remote_action==="test" && j.plan.target.source==="session"' "F-08: 'test' on the chat's pinned PC ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.scope.remote_action+" "+j.plan.target?.source'))"
  DID8=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).decision_id'); r=$(post "$A" "/api/aidev/decisions/$DID8" '{"final_target":"dev-mac"}' PATCH); check "$r" 'j.ok' "F-08: target override recorded on the route decision"
  post "$A" /api/aidev/session-settings/s-f08/target '{"target_id":null}' PUT >/dev/null; r=$(post "$A" /api/aidev/route '{"text":"내 맥에서 테스트 돌려서 결과 알려줘","sessionId":"s-f08"}'); check "$r" 'j.plan.target.source==="default"' "F-08: unpinned → the account default PC"
  post "$A" "/api/aidev/targets/$TID" '{"default":false}' PATCH >/dev/null
  r=$(post "$ADM" /api/aidev/route/eval '{"rows":[{"text":"React 컴포넌트에 다크모드 토글 훅을 추가해줘","agent":"frontend-react","lang":"ko"}],"remote_rows":[{"text":"내 맥에서 테스트 돌려서 결과 알려줘","remote_action":"test"},{"text":"이 함수 이름을 더 명확하게 바꿔줘","remote_action":"none"},{"text":"Build the release APK on my PC","remote_action":"build"},{"text":"내 PC에서 앱 화면 캡처해서 보여줘","remote_action":"screenshot"}]}')
  check "$r" 'j.remote && j.remote.n===4 && j.remote.lexical_only.accuracy>=0.75 && j.remote.sweep.length===28 && Object.keys(j)[0]==="remote"' "F-08: /route/eval reports remote_action first (nb $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).remote?.lexical_only.accuracy') fused $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).remote?.fused.accuracy'))"
  # F-03: remote exec — piped output + exit code in remote_runs, log, roots, ownership, policy, browser stream, restart adoption
  waitrun() { for i in $(seq 1 ${2:-60}); do r=$(get "$A" "/api/aidev/remote-runs/$1"); echo "$r" | grep -q '"finished_at":[0-9]' && break; sleep 0.25; done; echo "$r"; }
  r=$(post "$A" "/api/aidev/targets/$TID/exec" '{"cmd":"echo hello-remote; echo oops 1>&2; pwd; exit 3"}'); RR=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  check "$r" 'j.stream.streamId>0 && j.stream.remoteRunId>0 && (j.stream.running===true || j.stream.code===3) && j.stream.by==="user"' "exec started (stream $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.streamId'))"
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
  # F-06: preview — dev server on the runner's loopback through /p/<cap>/ (strip + keep modes, HMR socket, isolation)
  rpost() { curl -s -X POST "$G/internal/aidev$1" -H 'authorization: Bearer rtjwt-rt-alice' -H 'x-aidev-runtime: rt-alice' -H 'content-type: application/json' -d "$2"; }
  PP=$((20000 + RANDOM % 20000)); PK=$((PP + 1))
  node test/fake-devserver.mjs "$PP" > "$T/dev1.log" 2>&1 & DEV1=$!; sleep 0.4
  r=$(post "$A" "/api/aidev/targets/$TID/preview" "{\"port\":$PP,\"label\":\"plain\"}"); PB=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).preview?.base')
  check "$r" 'j.preview.mode==="strip" && /^\/p\/\d+-\d+-[A-Za-z0-9_-]{16}\/$/.test(j.preview.base) && j.preview.url.endsWith(j.preview.base) && /base/.test(j.hint)' "preview opened (strip mode, base $PB)"
  H=$(curl -s -D "$T/ph.txt" "$G$PB" -H "cookie: __Host-aidev-session=secret-cookie" -H "authorization: Bearer $A")
  check "{\"ok\":$(echo "$H" | grep -q "src=\"${PB}src/main.js\"" && echo "$H" | grep -q "href=\"${PB}about\"" && echo "$H" | grep -q 'src="//cdn.example' && echo "$H" | grep -q 'data-aidev-preview' && echo true || echo false)}" 'j.ok' "HTML: absolute paths rewritten under the prefix, shim injected, //cdn untouched"
  check "{\"ok\":$(grep -qi '^content-security-policy: sandbox allow-scripts' "$T/ph.txt" && ! grep -qi 'allow-same-origin' "$T/ph.txt" && grep -qi '^access-control-allow-origin: \*' "$T/ph.txt" && echo true || echo false)}" 'j.ok' "preview is sandboxed (opaque origin, no allow-same-origin) with CORS"
  r=$(curl -s "$G${PB}seen"); check "$r" "j.length>=1 && j.every(x=>x.host==='localhost:$PP' && x.cookie===null && x.auth===null)" "browser cookie/authorization never reach the dev server, Host = localhost:port"
  r=$(curl -s "$G${PB}src/main.js"); check "{\"ok\":$(echo "$r" | grep -q 'console.log' && echo true || echo false)}" 'j.ok' "module script proxied"
  curl -s -o /dev/null -D "$T/pr.txt" "$G${PB}redirect"; check "{\"ok\":$(grep -qi "^location: ${PB}login" "$T/pr.txt" && grep -qi "set-cookie: sid=1; Path=${PB}" "$T/pr.txt" && echo true || echo false)}" 'j.ok' "redirect to http://localhost:port/… and cookie path rewritten under the prefix"
  r=$(curl -s -X POST "$G${PB}post" -d 'abc'); check "{\"ok\":$([ "$r" = "got:abc" ] && echo true || echo false)}" 'j.ok' "request body forwarded (POST)"
  r=$(node test/preview-ws.mjs "$G" "${PB}hmr?token=x" || true); check "$r" "j.hello && j.hello.path==='/hmr?token=x' && j.hello.origin==='http://localhost:$PP' && j.echo==='echo:ping-hmr'" "WebSocket (HMR) through the tunnel, Origin rewritten"
  BAD=$(echo "$PB" | sed -E 's/-[A-Za-z0-9_-]{16}\/$/-AAAAAAAAAAAAAAAA\//'); r=$(curl -s -o /dev/null -w '%{http_code}' "$G$BAD"); check "{\"code\":$r}" 'j.code===404' "forged capability refused"
  OTHER=$(echo "$PB" | sed -E "s/-$PP-/-$PK-/"); r=$(curl -s -o /dev/null -w '%{http_code}' "$G$OTHER"); check "{\"code\":$r}" 'j.code===404' "a capability does not work for another port"
  r=$(post "$A" "/api/aidev/targets/$TID/preview" "{\"port\":$PK}"); KB=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).preview?.base')
  check "$r" "j.preview.error && /포트/.test(j.preview.error) && /열려 있는 포트: .*$PP \\(node\\)/.test(j.preview.error) && j.preview.base && /base/.test(j.hint)" "nothing listening → error with the base to start the server with and the ports that are open"
  node test/fake-devserver.mjs "$PK" "$KB" > "$T/dev2.log" 2>&1 & DEV2=$!; sleep 0.4
  r=$(post "$A" "/api/aidev/targets/$TID/preview" "{\"port\":$PK}"); check "$r" 'j.preview.mode==="keep" && !j.preview.error' "server started with the base → keep mode"
  H=$(curl -s "$G$KB"); check "{\"ok\":$(echo "$H" | grep -q "src=\"${KB}src/main.js\"" && ! echo "$H" | grep -q "${KB}${KB#/}" && echo true || echo false)}" 'j.ok' "keep mode: paths already under the base are not prefixed twice"
  r=$(node test/preview-ws.mjs "$G" "${KB}?token=y" || true); check "$r" "j.hello && j.hello.path==='${KB}?token=y' && j.echo==='echo:ping-hmr'" "keep mode: HMR socket gets the full base path"
  r=$(get "$A" /api/aidev/previews); check "$r" "j.previews.length>=2 && j.previews[0].port===$PK && j.previews.every(p=>p.online)" "previews listed for the user"
  r=$(get "$B" /api/aidev/previews); check "$r" 'j.previews.length===0' "another user sees none"
  r=$(post "$B" "/api/aidev/targets/$TID/preview" "{\"port\":$PP}"); check "$r" 'j.error' "another user cannot open a preview on the target"
  r=$(rpost "/targets/$TID/preview" "{\"port\":$PP,\"label\":\"agent app\"}"); check "$r" 'j.preview.by==="agent" && j.preview.mode==="strip"' "agent (runtime session) opens a preview"
  post "$A" "/api/aidev/targets/$TID" '{"policy":"deny"}' PATCH >/dev/null; r=$(curl -s -o /dev/null -w '%{http_code}' "$G$PB"); check "{\"code\":$r}" 'j.code===403' "policy deny blocks the preview"; post "$A" "/api/aidev/targets/$TID" '{"policy":"ask"}' PATCH >/dev/null
  # F-06b: the preview pane finds the ports and projects, starts a project's dev server, and previews it
  PD=$((PK + 1)); APP="$RH/aidev-work/demo-app"; mkdir -p "$APP"
  printf '{"name":"demo-app","scripts":{"dev":"node server.mjs"},"devDependencies":{"vite":"^6"}}\n' > "$APP/package.json"
  # stands in for `vite`: takes --base/--port like it, serves the fake dev server
  printf 'const a = process.argv; const v = (k) => a[a.indexOf(k) + 1];\nprocess.argv = [a[0], a[1], v("--port"), v("--base")];\nawait import(%s);\n' "\"$(pwd)/test/fake-devserver.mjs\"" > "$APP/server.mjs"
  r=$(get "$A" "/api/aidev/targets/$TID/dev?port=$PD"); DB=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).base')
  check "$r" "j.ports.some(p=>p.port===$PP && p.loopback && p.process==='node') && j.projects.some(p=>p.name==='demo-app' && p.framework==='vite' && p.base && p.command==='npm run dev -- --base {base} --port {port} --strictPort') && j.port===$PD && /^\\/p\\/\\d+-$PD-/.test(j.base)" "dev scan: open ports with their program, the project with its vite command, the preview path for the port"
  CMD=$(echo "$r" | node -pe "const j=JSON.parse(require('fs').readFileSync(0)); j.projects.find(p=>p.name==='demo-app').command.split('{port}').join('$PD').split('{base}').join(j.base)")
  r=$(post "$A" "/api/aidev/targets/$TID/exec" "{\"cmd\":\"$CMD\",\"cwd\":\"$APP\",\"pty\":true}"); DRR=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  for i in $(seq 1 40); do r=$(get "$A" "/api/aidev/targets/$TID/dev?port=$PD"); echo "$r" | grep -q "\"port\":$PD,\"pid\"" && break; sleep 0.5; done
  check "$r" "j.ports.some(p=>p.port===$PD && p.loopback)" "started from the pane: the project's dev server listens on the preview port (run #$DRR)"
  r=$(post "$A" "/api/aidev/targets/$TID/preview" "{\"port\":$PD}"); check "$r" "j.preview.mode==='keep' && !j.preview.error && j.preview.base==='$DB'" "…and its preview opens in keep mode (HMR path)"
  post "$A" "/api/aidev/remote-runs/$DRR/signal" '{"signal":"INT"}' >/dev/null
  kill $DEV1 $DEV2 2>/dev/null; wait $DEV1 $DEV2 2>/dev/null || true
  r=$(curl -s -w '|%{http_code}' "$G$PB"); check "{\"ok\":$(echo "$r" | grep -q '연결할 수 없습니다' && echo "$r" | grep -q '|503' && echo true || echo false)}" 'j.ok' "dev server stopped → 503 page (not 502: Cloudflare would replace it)"
  # F-07: screen — consent, screenshot (REST + jpg), shared stream with change-only frames, agent audit
  r=$(post "$A" "/api/aidev/targets/$TID/screenshot" '{}'); check "$r" '/허용하지 않았습니다/.test(j.error)' "no screen consent on the PC → refused with the command to enable it"
  kill $RPID 2>/dev/null; wait $RPID 2>/dev/null || true
  HOME="$RH" "$RUNNER_BIN" consent screen on >/dev/null
  SRC="$T/screen.png"; node test/make-png.mjs "$SRC" 10
  HOME="$RH" AIDEV_SCREEN_CMD="cp $SRC {out}" "$RUNNER_BIN" start > "$T/runner-screen.log" 2>&1 & RPID=$!
  for i in $(seq 1 40); do r=$(get "$A" /api/aidev/targets); echo "$r" | node -e "const j=JSON.parse(require('fs').readFileSync(0));process.exit(j.targets.find(t=>t.id===$TID)?.online && j.targets.find(t=>t.id===$TID).capabilities.screen ? 0 : 1)" && break; sleep 0.25; done
  r=$(get "$A" "/api/aidev/targets/$TID/windows"); check "$r" 'j.perWindow && j.windows.length>=1 && j.windows[0].id===1' "program windows listed (runner 0.7: per window)"
  r=$(post "$A" "/api/aidev/targets/$TID/screenshot" '{"maxWidth":320}'); check "$r" 'j.mime==="image/jpeg" && j.width===320 && j.height===180 && j.image.length>100 && j.remoteRunId>0' "screenshot scaled to 320x180 JPEG, recorded as a run"
  curl -s "$G/api/aidev/targets/$TID/screenshot.jpg?maxWidth=400" -H "authorization: Bearer $A" -o "$T/shot.jpg"; n=$(head -c 2 "$T/shot.jpg" | od -An -tx1 | tr -d ' '); check "{\"magic\":\"$n\"}" 'j.magic==="ffd8"' "screenshot.jpg serves image bytes (for <img>)"
  r=$(get "$A" "/api/aidev/remote-runs/$(post "$A" "/api/aidev/targets/$TID/screenshot" '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).remoteRunId')"); check "$r" 'j.run.kind==="screenshot" && j.run.approved_by==="user" && j.run.artifacts.width>0' "screen captures leave a trace (kind screenshot, by user)"
  r=$(node test/screen-client.mjs "$G" "$A" "$TID" "$SRC" || true); check "$r" 'j.started && j.frames1>=2 && j.lateViewerGotLastFrame && j.changedFrame && !j.error' "live screen: shared stream, last frame for a late viewer, new frame on change ($(echo "$r" | cut -c1-120))"
  r=$(curl -s -o /dev/null -w '%{http_code}' -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' -H "origin: http://evil.example" "$G/api/aidev/targets/$TID/screen?token=$A"); check "{\"code\":$r}" 'j.code===401' "screen socket from another origin refused"
  # F-07b/F-07c: a real program window on an X display (Xvfb) — the runner lists and captures it itself (x11rb),
  # encodes H.264 inside (OpenH264; nothing to install on the PC), and replays control relative to the window.
  # ffprobe only checks the bitstream here; ImageMagick `animate` is the program (a window that keeps changing).
  if command -v Xvfb >/dev/null && command -v animate >/dev/null && command -v xdotool >/dev/null && command -v ffprobe >/dev/null; then
    Xvfb :99 -screen 0 1280x720x24 >/dev/null 2>&1 & XPID=$!; sleep 0.8
    node -e "const [dir]=process.argv.slice(1),w=640,h=360;for(let f=0;f<8;f++){const b=Buffer.alloc(w*h*3);for(let i=0;i<w*h;i++){const x=i%w,y=(i/w)|0;const bar=Math.abs(x-f*80)<40;b[i*3]=bar?250:x%256;b[i*3+1]=bar?250:y%256;b[i*3+2]=140}require('fs').writeFileSync(dir+'/anim-'+f+'.ppm',Buffer.concat([Buffer.from('P6\\n'+w+' '+h+'\\n255\\n'),b]))}" "$T"
    DISPLAY=:99 animate -geometry +200+100 -delay 4 "$T"/anim-*.ppm >/dev/null 2>&1 & APID=$!; sleep 1.5
    r=$(node test/screen-video.mjs "$G" "$A" "$TID" :99 "$T" 1 refuse || true)
    check "$r" 'j.controlAvailable===false && /허용하지 않았습니다/.test(j.error||"")' "control without the owner's consent refused"
    kill $RPID 2>/dev/null; wait $RPID 2>/dev/null || true
    HOME="$RH" "$RUNNER_BIN" consent control on >/dev/null
    HOME="$RH" DISPLAY=:99 "$RUNNER_BIN" start > "$T/runner-video.log" 2>&1 & RPID=$!
    for i in $(seq 1 40); do r=$(get "$A" /api/aidev/targets); echo "$r" | node -e "const j=JSON.parse(require('fs').readFileSync(0));const t=j.targets.find(t=>t.id===$TID);process.exit(t?.online && t.capabilities.control ? 0 : 1)" && break; sleep 0.25; done
    r=$(get "$A" "/api/aidev/targets/$TID/windows")
    WIN=$(echo "$r" | node -pe 'const w=(JSON.parse(require("fs").readFileSync(0)).windows||[]).find(w=>/animate|imagemagick/i.test(w.app+" "+w.title)); w ? [w.id,w.x,w.y,w.width,w.height].join(",") : ""')
    check "{\"win\":\"$WIN\"}" '/^\d+,20[0-4],10[0-4],640,360$/.test(j.win)' "the program's window is listed with its content bounds (inside its X border) ($WIN; $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).windows.map(w=>w.app+":"+w.title).join(" | ").slice(0,120)'))"
    WID=${WIN%%,*}
    r=$(post "$A" "/api/aidev/targets/$TID/screenshot" '{"query":"animate","maxWidth":640}'); check "$r" 'j.width===640 && j.height===360 && j.window && /animate|imagemagick/i.test(j.window.app+j.window.title) && j.image.length>1000' "screenshot of one program window found by name (query)"
    r=$(get "$A" "/api/aidev/targets/$TID/runs?limit=5"); check "$r" 'j.runs.some(x=>x.kind==="screenshot" && /window #\d+/.test(x.cmd))' "the capture's trace names the window"
    r=$(node test/screen-video.mjs "$G" "$A" "$TID" :99 "$T" "$WIN" || true)
    check "$r" 'j.codec==="h264" && j.firstKind===1 && j.firstKey && j.firstNal===7 && j.frames>=45 && j.decoded>=40 && j.width===640' "live video of the window: H.264 made inside the runner, starts at a keyframe with SPS, the bitstream decodes ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.frames+" AUs, decoded "+j.decoded+", keys "+j.keys+", "+j.width+"x"+j.height'))"
    check "$r" 'j.lateFirstKey===true' "late viewer starts at a keyframe (GOP replay)"
    check "$r" 'j.controlAvailable===true && j.controlOn===false && j.mouseInWindow===true && !j.error' "remote control: the pointer lands at the same spot of the window on the PC ($(echo "$r" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0)); j.mouse+" expected "+j.expected'))"
    r=$(get "$A" "/api/aidev/targets/$TID/runs?limit=20"); check "$r" 'j.runs.some(x=>x.kind==="control" && x.approved_by==="user" && /window #/.test(x.cmd) && x.artifacts && x.artifacts.events>=4)' "control session recorded (kind control, which window, events counted)"
    PWDIR="$(npm root -g)/playwright"; if [ -d "$PWDIR" ]; then
      r=$(PLAYWRIGHT_DIR="$PWDIR" node test/screen-browser.mjs "$G" "$A" "$TID" :99 "$T/dist" "$WIN" || true)
      check "$r" 'j.codec==="jpeg" && j.width===640 && j.litSamples>50 && j.controlAvailable && j.pointerFollows && !j.error' "browser: the screen core draws the window on a canvas, real clicks on it land on the window on the PC ($(echo "$r" | cut -c1-160))"
    fi
    r=$(KILL_PID=$APID node test/screen-video.mjs "$G" "$A" "$TID" :99 "$T" "$WIN" close || true)
    check "$r" 'j.frames>=1 && /창/.test(j.error||"")' "closing the program ends its stream with a message ($(echo "$r" | cut -c1-120))"
    r=$(get "$A" "/api/aidev/targets/$TID/windows"); check "$r" '!j.windows.some(w=>w.id==='"${WID:-0}"')' "the closed window leaves the list"
    kill $XPID 2>/dev/null
    # back to the stand-in window for the checks below
    kill $RPID 2>/dev/null; wait $RPID 2>/dev/null || true
    HOME="$RH" AIDEV_SCREEN_CMD="cp $SRC {out}" "$RUNNER_BIN" start > "$T/runner-screen2.log" 2>&1 & RPID=$!
    for i in $(seq 1 40); do r=$(get "$A" /api/aidev/targets); echo "$r" | node -e "const j=JSON.parse(require('fs').readFileSync(0));process.exit(j.targets.find(t=>t.id===$TID)?.online ? 0 : 1)" && break; sleep 0.25; done
  else echo "SKIP window video/control checks (needs Xvfb, ImageMagick animate, xdotool, ffprobe)"; fi
  r=$(post "$B" "/api/aidev/targets/$TID/screenshot" '{}'); check "$r" 'j.error' "another user cannot see the screen"
  r=$(rpost "/targets/$TID/screenshot" '{"maxWidth":320}'); check "$r" 'j.image && j.width===320' "agent (runtime session) takes a screenshot"
  post "$A" "/api/aidev/targets/$TID" '{"policy":"deny"}' PATCH >/dev/null; r=$(rpost "/targets/$TID/screenshot" '{}'); check "$r" '/실행 금지/.test(j.error)' "policy deny: agent screenshots refused"; post "$A" "/api/aidev/targets/$TID" '{"policy":"ask"}' PATCH >/dev/null
  # F-10: attached devices — a stand-in adb with one usable phone, one waiting for USB-debugging consent
  FADB="$T/fake-adb"; cat > "$FADB" <<FAKE
#!/bin/sh
case "\$*" in
  "devices -l") printf 'List of devices attached\\nfake-0001 device product:p model:Pixel_7 device:d transport_id:1\\nfake-0002 unauthorized usb:1 transport_id:2\\n\\n' ;;
  "-s fake-0001 exec-out screencap -p") cat "$SRC" ;;
  *) echo "unexpected: \$*" >&2; exit 1 ;;
esac
FAKE
  chmod +x "$FADB"
  kill $RPID 2>/dev/null; wait $RPID 2>/dev/null || true
  HOME="$RH" AIDEV_ADB="$FADB" AIDEV_SCREEN_CMD="cp $SRC {out}" "$RUNNER_BIN" start > "$T/runner-devices.log" 2>&1 & RPID=$!
  for i in $(seq 1 40); do r=$(get "$A" /api/aidev/targets); echo "$r" | node -e "const j=JSON.parse(require('fs').readFileSync(0));process.exit(j.targets.find(t=>t.id===$TID)?.online ? 0 : 1)" && break; sleep 0.25; done
  r=$(get "$A" "/api/aidev/targets/$TID/devices"); check "$r" 'j.devices.some(d=>d.tool==="adb" && d.serial==="fake-0001" && d.name==="Pixel 7" && d.state==="device") && j.devices.some(d=>d.serial==="fake-0002" && d.state==="unauthorized")' "F-10: attached devices listed (adb, one waiting for USB-debugging consent)"
  r=$(post "$A" "/api/aidev/targets/$TID/devices/shot" '{"tool":"adb","serial":"fake-0001","maxWidth":320}'); check "$r" 'j.mime==="image/jpeg" && j.width===320 && j.height===180 && j.device.name==="Pixel 7" && j.remoteRunId>0' "device screen as a 320px JPEG, recorded as a run"
  r=$(get "$A" "/api/aidev/targets/$TID/runs?limit=3"); check "$r" 'j.runs.some(x=>x.kind==="screenshot" && /^device\.shot adb fake-0001/.test(x.cmd))' "the capture's trace names the device"
  SRR=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).runs.find(x=>x.kind==="screenshot").id')
  n=$(curl -s "$G/api/aidev/remote-runs/$SRR/image" -H "authorization: Bearer $A" | head -c 2 | od -An -tx1 | tr -d ' '); check "{\"magic\":\"$n\"}" 'j.magic==="ffd8"' "the capture's image is kept for result cards (JPEG)"
  r=$(curl -s -o /dev/null -w '%{http_code}' "$G/api/aidev/remote-runs/$SRR/image" -H "authorization: Bearer $B"); check "{\"code\":$r}" 'j.code===404' "another user cannot fetch the image"
  r=$(post "$A" "/api/aidev/targets/$TID/devices/shot" '{"serial":"fake-0002"}'); check "$r" '/fake-0002/.test(j.error)' "a device without USB-debugging consent is not captured"
  r=$(rpost "/targets/$TID/devices/shot" '{"serial":"fake-0001","maxWidth":320}'); check "$r" 'j.image && j.device.serial==="fake-0001"' "agent (runtime session) looks at the device screen"
  r=$(post "$B" "/api/aidev/targets/$TID/devices/shot" '{"serial":"fake-0001"}'); check "$r" 'j.error' "another user cannot see the device"
  # mouse/keyboard on a window: the owner's control consent first, then agents too (full permissions)
  r=$(rpost "/targets/$TID/input" '{"window":999999901,"actions":[{"type":"click","x":10,"y":10}]}'); check "$r" '/원격 제어를 허용하지 않았습니다/.test(j.error)' "input: no control consent on the PC → refused"
  kill $RPID 2>/dev/null; wait $RPID 2>/dev/null || true; HOME="$RH" "$RUNNER_BIN" consent control on >/dev/null
  HOME="$RH" AIDEV_ADB="$FADB" AIDEV_SCREEN_CMD="cp $SRC {out}" "$RUNNER_BIN" start > "$T/runner-input.log" 2>&1 & RPID=$!
  for i in $(seq 1 40); do r=$(get "$A" /api/aidev/targets); echo "$r" | node -e "const j=JSON.parse(require('fs').readFileSync(0));const t=j.targets.find(t=>t.id===$TID);process.exit(t?.online && t.capabilities.control ? 0 : 1)" && break; sleep 0.25; done
  r=$(rpost "/targets/$TID/input" '{"window":999999901,"imageWidth":640,"imageHeight":360,"actions":[{"type":"click","x":320,"y":180},{"type":"type","text":"hi"},{"type":"key","key":"Enter"}]}'); IRR=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).remoteRunId')
  check "$r" 'j.ok && j.events===5 && j.remoteRunId>0' "agent: click, type and Enter sent to the window (5 events)"
  r=$(get "$A" "/api/aidev/remote-runs/$IRR"); check "$r" 'j.run.kind==="control" && j.run.approved_by==="agent" && /type \"hi\"/.test(j.run.cmd) && j.run.exit_code===0' "…recorded as a control run by the agent"
  r=$(rpost "/targets/$TID/input" '{"window":999999901,"actions":[{"type":"click","x":320,"y":180}]}'); check "$r" '/imageWidth/.test(j.error)' "pixel coordinates without the screenshot size → refused"
  r=$(post "$B" "/api/aidev/targets/$TID/input" '{"window":999999901,"actions":[{"type":"key","key":"a"}]}'); check "$r" 'j.error' "another user cannot control the PC"
  # F-05: agent (runtime session) → gate: safe commands run, risky ones wait for the user, tests feed the chat run
  rpost() { curl -s -X POST "$G/internal/aidev$1" -H 'authorization: Bearer rtjwt-rt-alice' -H 'x-aidev-runtime: rt-alice' -H 'content-type: application/json' -d "$2"; }
  rget() { curl -s "$G/internal/aidev$1" -H 'authorization: Bearer rtjwt-rt-alice' -H 'x-aidev-runtime: rt-alice'; }
  mkdir -p "$RH/aidev-work"; echo '{"name":"t","scripts":{"test":"echo 3 passing"}}' > "$RH/aidev-work/package.json"
  RUN2=$(post "$A" /api/aidev/runs "{\"decision_id\":$DID,\"session_id\":\"s-remote\",\"engine\":\"claude\",\"model\":\"sonnet\",\"effort\":\"high\",\"agent_id\":1,\"depth\":2,\"task_kind\":\"implement\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).run_id')
  r=$(rpost "/targets/$TID/exec" "{\"cmd\":\"npm test\",\"runId\":$RUN2,\"agent\":\"testing\"}"); RR3=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  check "$r" 'j.status==="started" && j.stream.by==="auto" && j.assessment.safe===true' "agent: test command runs without asking (policy ask, risk $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).assessment?.risk'))"
  r=$(rget "/remote-runs/$RR3/wait?timeout=20"); check "$r" 'j.run.exit_code===0 && /3 passing/.test(j.output) && j.run.run_id>0' "agent: waits for the result (exit 0, output returned)"
  r=$(get "$A" "/api/aidev/runs?limit=5"); check "$r" "(j.runs||[]).some(x=>x.id===$RUN2 && x.test_result==='pass')" "remote test result recorded on the chat run (test_result=pass)"
  r=$(get "$A" "/api/aidev/remote-runs?session=s-remote"); check "$r" "j.runs.length>=1 && j.runs.every(x=>x.run_id===$RUN2) && j.runs.some(x=>x.id===$RR3)" "the chat session's remote runs (mobile result cards)"
  r=$(get "$B" "/api/aidev/remote-runs?session=s-remote"); check "$r" 'j.runs.length===0' "another user's session filter finds nothing"
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
  # full permissions (default since 2026-10-01): nothing waits, the command is recorded as the agent's
  post "$A" "/api/aidev/approvals/$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).approval.id')" '{"allow":false}' >/dev/null
  post "$A" "/api/aidev/targets/$TID" '{"policy":"full"}' PATCH >/dev/null
  r=$(rpost "/targets/$TID/exec" '{"cmd":"rm -rf full-perm-tmp && echo gone","agent":"testing"}'); FRR=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).stream?.remoteRunId')
  check "$r" 'j.status==="started" && j.stream.by==="auto" && j.assessment.destructive' "policy full: a destructive command runs without asking (still assessed: $(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).assessment?.reasons.join(", ")'))"
  r=$(rget "/remote-runs/$FRR/wait?timeout=20"); check "$r" 'j.run.exit_code===0 && j.run.approved_by==="auto" && /gone/.test(j.output)' "…recorded as run #$FRR (approved_by auto)"
  r=$(post "$A" /api/aidev/targets '{"name":"new-pc-full"}'); check "$r" 'j.target.policy==="full"' "a new PC starts with full permissions"; post "$A" "/api/aidev/targets/$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).target.id')" '' DELETE >/dev/null
  post "$A" "/api/aidev/targets/$TID" '{"policy":"auto"}' PATCH >/dev/null
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
  # F-09: remote debugging — the runner provisions the adapter (AIDEV_ADAPTER_MIRROR here), the gateway speaks DAP through a tunnel
  if [ -n "${AIDEV_ADAPTER_MIRROR:-}" ]; then
    jv() { echo "$1" | node -pe "const j=JSON.parse(require('fs').readFileSync(0)); $2"; }
    DBG="$RH/aidev-work/dbg"; mkdir -p "$DBG"
    printf 'function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nlet total = 0;\nfor (let i = 0; i < 3; i++) total = add(total, i);\nconsole.log("total", total);\n' > "$DBG/app.js"
    printf 'def add(a, b):\n    s = a + b\n    return s\n\ntotal = 0\nfor i in range(3):\n    total = add(total, i)\nprint("total", total)\n' > "$DBG/app.py"
    r=$(post "$A" "/api/aidev/targets/$TID/debug" '{"adapter":"js-debug","program":"app.js","cwd":"~/aidev-work/dbg","breakpoints":[{"path":"app.js","line":2}],"waitSec":90}'); DS=$(jv "$r" 'j.session?.id')
    check "$r" 'j.session.state==="paused" && j.session.frames.find(f=>!f.internal).line===2 && j.session.locals.some(v=>v.name==="a"&&v.value==="0") && j.session.breakpoints[0].verified' "F-09 js-debug via the runner: paused at app.js:2, a=0 ($(jv "$r" 'j.session?.version+" "+(j.session?.error||"")'))"
    r=$(post "$A" "/api/aidev/debug/$DS/evaluate" '{"expression":"a + b"}'); check "$r" 'j.result==="0"' "F-09 evaluate a+b while paused"
    r=$(post "$A" "/api/aidev/debug/$DS/control" '{"action":"next","waitSec":10}'); check "$r" 'j.session.state==="paused" && j.session.stopped.reason==="step" && j.session.frames.find(f=>!f.internal).line===3' "F-09 step over → line 3"
    r=$(get "$A" "/api/aidev/debug/$DS/events?after=0"); check "$r" 'j.events.some(e=>e.type==="state"&&e.state==="paused"&&e.location.line===2) && j.next>0' "F-09 events: paused at line 2 recorded"
    r=$(get "$A" "/api/aidev/targets/$TID/file?path=~/aidev-work/dbg/app.js"); check "$r" '/function add/.test(j.text)' "F-09 source view reads the file on the PC"
    r=$(get "$A" "/api/aidev/targets/$TID/file?path=/etc/passwd"); check "$r" 'j.error' "F-09 source view stays in the allowed folders"
    r=$(get "$B" "/api/aidev/debug/$DS"); check "$r" 'j.error' "F-09 another user cannot see the session"
    r=$(post "$A" "/api/aidev/debug/$DS/breakpoints" '{"path":"app.js","lines":[]}'); check "$r" 'j.breakpoints.length===0' "F-09 breakpoints cleared"
    r=$(post "$A" "/api/aidev/debug/$DS/control" '{"action":"continue","waitSec":30}'); check "$r" 'j.session.state==="ended" && /total 3/.test(j.session.output)' "F-09 continued to the end (output: total 3)"
    r=$(get "$A" "/api/aidev/remote-runs/$(jv "$r" 'j.session.remoteRunId')"); check "$r" 'j.run.kind==="debug" && j.run.approved_by==="user" && j.run.finished_at>0' "F-09 the session is a remote run (kind debug)"
    # the agent: policy ask → a program under the debugger needs the user's OK, then it drives the session
    r=$(rpost "/targets/$TID/debug" '{"adapter":"debugpy","program":"app.py","cwd":"~/aidev-work/dbg","breakpoints":[{"path":"app.py","line":2}],"waitSec":60,"agent":"testing"}'); APD=$(jv "$r" 'j.approval?.id')
    check "$r" 'j.status==="pending" && j.approval.kind==="debug" && /python3 app.py/.test(j.approval.cmd)' "F-09 agent: debugging python3 app.py asks first"
    (sleep 1; post "$A" "/api/aidev/approvals/$APD" '{"allow":true}' >/dev/null) &
    r=$(rget "/approvals/$APD/wait?timeout=20"); DS2=$(jv "$r" 'j.approval?.debugSessionId')
    check "$r" 'j.approval.status==="allowed" && j.approval.debugSessionId && j.approval.remoteRunId>0' "F-09 agent: allowed → the session starts (debugpy provisioned via pip)"
    r=$(rget "/debug/$DS2?wait=60"); check "$r" 'j.session.state==="paused" && j.session.frames[0].line===2 && j.session.locals.some(v=>v.name==="a"&&v.value==="0")' "F-09 agent: paused at app.py:2 with a=0 ($(jv "$r" 'j.session?.state+" "+(j.session?.error||"")'))"
    r=$(rpost "/debug/$DS2/control" '{"action":"continue","waitSec":20}'); check "$r" 'j.session.state==="paused" && j.session.locals.some(v=>v.name==="b"&&v.value==="1")' "F-09 agent: continue → next hit b=1"
    r=$(curl -s -X DELETE "$G/api/aidev/debug/$DS2" -H "authorization: Bearer $A"); check "$r" 'j.session.state==="ended"' "F-09 user stops the agent's session"
    r=$(rpost "/targets/$TID/rpc" '{"method":"dap.list","params":{}}'); check "$r" 'j.result && j.result.sessions.length===0' "F-09 the runner has no adapter left"
  else echo "SKIP F-09 remote debugging (set AIDEV_ADAPTER_MIRROR)"; fi
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
  cp "$T/old-runner.toml" "$AIDEV_RUNNER_HOME/runner.toml"; code=0; HOME="$RH" perl -e 'alarm shift; exec @ARGV' 10 "$RUNNER_BIN" start >/dev/null 2>&1 || code=$?
  check "{\"code\":$code}" 'j.code===3' "old token no longer connects"
  unset AIDEV_RUNNER_HOME
else echo "SKIP runner checks (build deploy/aidev/runner first: cargo build)"; fi
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "--- gateway log"; tail -20 "$T/gw.log"; exit 1; }
