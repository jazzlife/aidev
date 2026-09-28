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
  RUNTIME_MANAGER_URL=http://127.0.0.1:18090 LAYA_URL=http://127.0.0.1:18095 PUBLIC_ORIGIN=http://127.0.0.1:18080 PORT=18080 STATIC_ROOT="$T/dist"
mkdir -p "$T/dist" "$T/dist-mobile"; echo '<html>workbench</html>' > "$T/dist/index.html"; echo '<html>mobile</html>' > "$T/dist-mobile/index.html"
# accounts: alice (both engines), bob (codex only, runtime rt-codexonly)
node -e "
const {openStore}=await import('./dist/store.js'); const s=openStore(process.env.DATABASE_PATH);
await s.add('alice','pw1234','rt-alice',1); await s.add('bob','pw1234','rt-codexonly',1); await s.add('admin','pw1234','rt-admin',1);
s.setAccountEngines('bob',['codex']); s.setRole('admin','admin'); s.db.close();" --input-type=module
node dist/auth-gateway.js >"$T/gw.log" 2>&1 &
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
r=$(post "$A" "/api/aidev/runs/$RID/outcome" '{"user_feedback":"down"}' PATCH); check "$r" 'j.run.outcome==="fail"' "run outcome fail after 👎"
r=$(post "$A" "/api/aidev/decisions/$DID" '{"final_agent":"backend-node","final_engine":"codex"}' PATCH); check "$r" 'j.ok' "decision override"
r=$(post "$A" /api/aidev/agents '{"name":"unity-shader","domain":"gamedev","description":"Unity shader and rendering: HLSL, ShaderLab, URP, VFX. 유니티 셰이더, 렌더링, 머티리얼.","prompt":"You are a Unity rendering engineer with deep ShaderLab/HLSL knowledge. Verify with a test scene.","knowledge":[{"title":"URP 17 shader API","body":"URP 17 (Unity 6) changed the Blit API; use Blitter.BlitCameraTexture.","source_url":"https://docs.unity3d.com/","source_date":"2026-01-10"}]}'); AID=$(echo "$r" | node -pe 'JSON.parse(require("fs").readFileSync(0)).agent.id'); check "$r" 'j.agent.name==="unity-shader" && j.agent.ownerId===1' "private agent created"
r=$(post "$A" /api/aidev/route '{"text":"Unity 셰이더로 물 표면 굴절 효과를 구현해줘"}'); check "$r" 'j.agent.name==="unity-shader" && j.decision==="use"' "new agent is routed to next time"
r=$(get "$A" "/api/aidev/knowledge?q=Blit"); check "$r" 'j.knowledge.length===1' "knowledge FTS search"
r=$(post "$A" "/api/aidev/agents/$AID" '{"prompt":"You are a Unity rendering engineer (v2). Always profile with the Frame Debugger before optimizing.","changelog":"add profiling rule"}' PUT); check "$r" 'j.version===2' "agent new version"
r=$(get "$A" "/api/aidev/agents/$AID"); check "$r" 'j.versions.length===2 && j.knowledge.length===1' "agent detail versions+knowledge"
r=$(get "$B" "/api/aidev/agents/$AID"); check "$r" 'j.error' "private agent hidden from other user"
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
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "--- gateway log"; tail -20 "$T/gw.log"; exit 1; }
