# Nado AI Dev Platform — 구현 계획·체크리스트

> 이 문서는 구현 중 방향을 잃지 않기 위한 단일 기준 문서다. 모든 작업은 여기의 항목 ID(B-01 …)로 추적하고,
> 완료 시 `[x]`와 릴리스 ID를 적는다. 여기 없는 일을 하게 되면 먼저 이 문서를 고친다.
> 위치: 저장소 `docs/aidev/IMPLEMENTATION-PLAN.md`, 프로젝트 문서 `claude/implementation-plan.md`, Mac `NadoVibe/ops/IMPLEMENTATION-PLAN.md` (셋은 같은 내용, 저장소가 원본).

---

## 0. 변하지 않는 것 (매 작업 전에 확인)

### 목표
사용자 명령 → **범위·깊이·작업 성격 판정** → **전문 agent 선택**(없으면 생성) → **계정이 쓸 수 있는 엔진(Claude Code / Codex)** 중 작업 성격·깊이에 맞는 **모델·추론 강도**로 실행 → 결과·실패 신호를 기록 → **교훈과 검증된 최신 지식이 agent에 축적**되어 다음 실행이 좋아지는 AI 코딩 플랫폼. 모바일·태블릿·데스크탑 대응.

### 원칙 (어기면 안 됨)
1. **원격 서버 AI-PC(100.64.0.9, `ai-turtle`)에서만 운영.** 로컬(Mac)에서 서비스를 돌리지 않는다. Mac은 `ops/relay.sh`로 SSH 중계만, 클라우드 작업공간(`/home/claude/aidev`)은 빌드만.
2. **저장소 연동 없음, 이미지 재빌드 없음.** 배포 = `pack.sh` → `release-<sha>.tgz` → `relay.sh deploy` → 서버 `deploy.sh`가 볼륨 `releases/<sha>/`에 풀고 `current` 원자 교체 → 바뀐 프로세스만 재시작. 도구 이미지(`cloudcli-runtime`, `laya-runtime`)는 도구 버전이 바뀔 때만.
3. **기존 인프라 불변**: NPM(4.conf), Portainer, 인증서, 네트워크(npm_bridge/aidev-control-net/aidev-<user>-net), 시크릿, 사용자 볼륨, `~/aidev/source`.
4. **CloudUI upstream 수정 최소화**: 본체는 `server/modules/providers/list/claude/claude-runtime.provider.js`, `server/modules/providers/list/codex/codex-runtime.provider.ts`, `src/modules/chat/hooks/useChatComposerState.ts`, `src/modules/chat/ChatInterface.tsx` 네 곳만. 나머지는 새 모듈 `src/modules/aidev-router/`와 게이트웨이(`deploy/aidev/auth-gateway`)에.
5. **Laya는 결정만, 생성은 LLM.** 텍스트가 필요한 모든 것(agent 프롬프트, 지식, 교훈)은 계정이 쓸 수 있는 엔진이 만든다.
6. **검증되지 않은 지식은 주입하지 않는다.** verified(테스트/승인) · sourced(공식 출처+날짜) · unverified(보관만).
7. 서버에서 실제로 동작 확인한 것만 "완료". 로그는 `ops/inbox/`로 회수해 읽는다.
8. 비밀번호·토큰은 Claude가 입력하지 않는다. 배포 명령은 사용자가 실행한다.

### 확정된 결정
- 결정 모델: **Laya multilingual** (jev 대체). 서버 iGPU(Radeon 890M, `HSA_OVERRIDE_GFX_VERSION=11.5.0`)에서 `/route` ≈150ms.
- 실행 엔진: **Claude Code, Codex.** 계정별 가용 엔진 상이(Codex 전용 / 둘 다).
- 두 엔진 모두 가능할 때 **대량 데이터 분석·읽기 → Codex 가중치 상향.** 그 외 중립, 실행 기록으로 학습.
- 전문 agent = 엔진 중립 정의(프롬프트 + 지식 팩 SKILL.md + 도구 MCP + 교훈). 엔진별 어댑터로 변환.
- 깊이 D0~D4 → 엔진별 모델/effort 표(§3.4). 위험도 높으면 한 단계 상향. 사용자 지정 최우선.
- 전문성↔속도: 맞는 agent 확실 → 사용 / 애매+얕음 → 범용 빠른 경로 / 없음+D0~1 → 범용 처리 후 백그라운드 생성 / 없음+D2+ → 생성 후 실행.
- 교훈·지식은 **사용자 범위**로 축적, 전역 승격은 관리자 승인 (기본값, 미확인).
- 계정 엔진 권한은 **`aidev-user` CLI 옵션**으로 관리, 관리 UI는 나중 (기본값, 미확인).
- CloudCLI 세션은 provider 고정 → 엔진 선택은 새 세션 시작 시점, 도중 전환은 요약 handoff 새 세션.

### 하지 않을 것 (지금은)
- NPU(XDNA2) 활용, 다중 호스트, 게이트웨이 이중화, admin.nado.work UI, 기존 NadoVibe 연동.

---

## 1. 현재 상태 (2026-09-23)

| 항목 | 상태 | 근거 |
|---|---|---|
| 서버 릴리스 볼륨 모델 | 완료 | 활성 릴리스 `a293400f8fc7` → `1da6063f7c55`(게이트웨이 Laya 프록시 포함) |
| Laya 서비스 | 완료, GPU | `aidev-laya`, `device: cuda`, 라우팅 3/3 정답 |
| 게이트웨이 DB `agents`, `decision_log` | 스키마만 | 커밋 41aee367 (미배포) |
| 게이트웨이 `/api/aidev/route|decide|laya/health` | 배포됨 | Laya 직접 프록시(카탈로그 미연동) |
| provider 훅, 프런트, 생성, 학습 | 미착수 | |

클라우드 저장소 `main` 최신: `41aee367` (+ 이 문서). 다음 릴리스부터 B 단계 반영.

---

## 2. 시스템 구성 (구현 대상 전체 지도)

```
브라우저 (CloudUI 포크 + src/modules/aidev-router)
   │  POST /api/aidev/route  {text, sessionId?, engine?}          ← 전송 직전
   │  chat.send options.aidev = {agent, engine, model, effort, runId}
   ▼
aidev-auth-gateway (control/gateway, node:22 + 볼륨)
   ├─ SQLite /data/auth.db: accounts(+engines), agents, agent_versions, knowledge, lessons,
   │                        decision_log, runs, engine_status, engine_weights, tier_policy
   ├─ /api/aidev/*  (route, agents, runs, lessons, knowledge, engines, export)
   ├─ Laya 호출 ──────────────► aidev-laya (control/laya/app.py, iGPU)  /route /decide /health
   └─ 런타임 인증 상태 질의 ──► aidev-cloudcli-<user>:3001 /api/providers/:p/auth/status
   │
   │  /api/*, /ws, /shell  (기존 프록시)
   ▼
aidev-cloudcli-<user> (cloudcli-runtime 이미지 + 볼륨 current)
   ├─ server: chat-websocket → provider-runtime → claude-runtime.provider.js (Agent SDK)
   │                                             → codex-runtime.provider.ts (codex-sdk)
   ├─ ~/.claude/skills, ~/.agents/skills  ← 지식 팩(SKILL.md) 공유 볼륨 aidev_agents (ro)
   └─ 실행 결과 이벤트(complete/exit, tool error, 사용자 피드백) → 프런트 → POST /api/aidev/runs/:id/outcome
```

---

## 3. 명세 (구현 시 그대로 따를 것)

### 3.1 Laya 판정 질문 (한 번의 `/route` 호출)
`state = {command, project_hint?, recent_files?}` (1024 토큰 예산 — command 우선, 나머지 잘라냄)

| id | type | criteria / 설명 |
|---|---|---|
| `agent` | choice | 카탈로그 `{name: description}` (≤20, 초과 시 shortlist) |
| `needs_new` | noul | "목록의 어떤 agent도 이 분야에 맞지 않는가" |
| `depth` | score | 0 즉답·조회·한 줄 / 1 한 파일 국소 수정 / 2 여러 파일 기능 / 3 원인불명 디버깅·리팩터링·설계 / 4 아키텍처·마이그레이션·장기 |
| `task_kind` | choice | `bulk_read`(대량 데이터/파일/로그 분석·읽기·요약) · `implement` · `debug` · `refactor` · `design` · `ops` · `explain` |
| `risk` | score | 0 읽기전용 / 1 파일 수정 / 2 파괴적·되돌리기 어려움 |
| `multi_domain` | noul | "둘 이상의 전문 분야에 걸치는가" |

응답에 `latency_ms`, `device`, 각 확률 포함. **LLM 정밀 분석 조건**: `agent` 확률 < 0.5 이거나 `depth` ≥ 2.5 이거나 `multi_domain` > 0.6.

### 3.2 데이터 모델 (게이트웨이 SQLite, `store.ts`)
이미 있음: `accounts`, `gateway_sessions`, `agents`, `decision_log`.

```sql
ALTER TABLE accounts ADD COLUMN engines TEXT NOT NULL DEFAULT 'claude,codex';   -- 'codex' | 'claude,codex' | 'claude'
ALTER TABLE accounts ADD COLUMN default_engine TEXT;                            -- NULL = 점수로 결정

CREATE TABLE agent_versions (id PK, agent_id REF agents, version INT, prompt TEXT, tools TEXT, model TEXT,
  skills TEXT /*json*/, mcp_servers TEXT /*json*/, changelog TEXT, created_at INT, UNIQUE(agent_id, version));
CREATE TABLE knowledge (id PK, agent_id REF agents, title TEXT, body TEXT /*markdown*/, source_url TEXT,
  source_date TEXT, status TEXT /*verified|sourced|unverified|superseded*/, superseded_by INT,
  expires_at INT, owner_id INT NULL, created_at INT, updated_at INT);
CREATE TABLE lessons (id PK, agent_id REF agents, engine TEXT NULL, trigger TEXT /*실패 상황*/, rule TEXT /*다음에 할 것*/,
  evidence_run_id INT, status TEXT /*verified|candidate|rejected*/, hits INT DEFAULT 0, owner_id INT NULL,
  promoted_to_prompt INT DEFAULT 0, created_at INT);
CREATE TABLE runs (id PK, user_id INT, session_id TEXT, decision_id INT REF decision_log, agent_id INT NULL, agent_version INT NULL,
  engine TEXT, model TEXT, effort TEXT, depth REAL, task_kind TEXT, risk REAL,
  started_at INT, finished_at INT, exit_code INT, tool_errors INT DEFAULT 0, user_feedback TEXT /*up|down|null*/,
  reverted INT DEFAULT 0, reasked INT DEFAULT 0, test_result TEXT /*pass|fail|null*/, cost_tokens INT,
  escalated_from_run INT NULL, outcome TEXT /*success|fail|unknown*/);
CREATE TABLE engine_status (user_id INT, engine TEXT, authenticated INT, checked_at INT, last_error TEXT, PRIMARY KEY(user_id, engine));
CREATE TABLE engine_weights (task_kind TEXT, engine TEXT, weight REAL, PRIMARY KEY(task_kind, engine));   -- 시드: bulk_read/codex 0.7, bulk_read/claude 0.3, 나머지 0.5/0.5
CREATE TABLE tier_policy (domain TEXT, depth INT, engine TEXT, model TEXT, effort TEXT, success_n INT, fail_n INT, avg_ms INT, PRIMARY KEY(domain, depth, engine));
```

### 3.3 게이트웨이 API (`/api/aidev/*`, 세션 필수)
| 메서드 | 경로 | 입력 → 출력 |
|---|---|---|
| POST | `/route` | `{text, sessionId?, sessionEngine?, preferEngine?}` → `{decision_id, scope:{depth,task_kind,risk,multi_domain}, agent:{name,version,definition}, alternatives[], needs_new, plan:{engine, model, effort, reason[]}, engines:{claude:{allowed,authenticated}, codex:{…}}, latency_ms}` |
| PATCH | `/decisions/:id` | `{final_agent?, final_engine?, final_model?}` (사용자 override 기록) |
| GET/POST | `/agents` | 목록(전역+개인) / 생성 `{name, domain, description, prompt, tools?, model?, skills?, mcp_servers?}` |
| GET/PUT/DELETE | `/agents/:id` | 상세(현재 버전+지식+교훈 요약) / 수정(새 버전 생성) / 비활성 |
| POST | `/agents/:id/promote` | 개인 → 전역 (관리자만) |
| POST | `/runs` | `{decision_id, session_id, engine, model, effort}` → `{run_id}` |
| PATCH | `/runs/:id/outcome` | `{exit_code?, tool_errors?, user_feedback?, reverted?, reasked?, test_result?, cost_tokens?}` |
| GET | `/runs?agent=&limit=` | 기록 |
| POST | `/lessons` / PATCH `/lessons/:id` | 후보 등록(정제 결과) / 검증·거절·승격 |
| POST | `/knowledge` / PATCH `/knowledge/:id` | 등록 / 상태 변경 |
| GET | `/engines` | 계정 가용 엔진 + 인증 상태(캐시 60s) |
| GET | `/export/decisions` | Laya 학습용 `(command, label, depth, task_kind)` JSONL |

### 3.4 실행 등급 표 (초기값, `tier_policy`가 비어 있을 때)
| depth | Claude model/effort | Codex model/effort | 장착 |
|---|---|---|---|
| 0 | haiku / low | gpt-5.6-luna / low | 프롬프트만 |
| 1 | sonnet / medium | gpt-5.6-terra / medium | + 교훈 top-3 |
| 2 | sonnet / high | gpt-5.6-terra / high | + 지식 요약(≤2k 토큰) |
| 3 | opus / high (fable 가능 시 fable) | gpt-5.6-sol / high | + 지식 전체, 교훈 전부, 교차 검토 |
| 4 | opusplan 또는 fable / xhigh | gpt-6-astra / xhigh | + 다중 agent |
- `risk ≥ 1.5` → depth +1. 사용자 지정 model/effort/engine → 그대로.
- 엔진 점수: `w(task_kind, engine)` + `tier_policy 성공률 보정(±0.2)` − `패널티(최근 1h 오류 0.3, 인증 없음 → 제외)`. 동점 → `accounts.default_engine` → claude.
- 세션이 이미 provider를 가지면 엔진은 그 provider로 고정(점수 무시), 모델/effort만 결정.

### 3.5 엔진 어댑터 (런타임 안)
- 공통 옵션 (프런트 → `chat.send options.aidev`):
  `{ runId, agent: {name, version, prompt, description, tools?, model?, skills?[], mcpServers?}, lessons: string[], knowledgeDigest?: string, engine, model, effort }`
- **Claude** (`claude-runtime.provider.js` `mapCliOptionsToSDK`): `aidev` 있으면
  `sdkOptions.agents = { [name]: {description, prompt: prompt + "\n\n## 교훈\n" + lessons + knowledgeDigest, tools, model, skills, mcpServers, maxTurns} }`, `sdkOptions.agent = name`, `sdkOptions.model = model`, effort는 기존 `applyClaudeEffort`.
- **Codex** (`codex-runtime.provider.ts`): `aidev` 있으면 `new Codex({ config: { developer_instructions: <같은 합성 프롬프트>, mcp_servers: mcpServers } })`, `threadOptions.model/modelReasoningEffort`는 기존 경로.
- 화이트리스트 외 필드는 버린다. 프롬프트 합성 최대 길이 = depth별(D0 2k, D1 4k, D2 8k, D3+ 제한 없음).
- 지식 팩(skills): `aidev_agents` 볼륨 `/srv/agents/skills/<agent>/SKILL.md` → 런타임 `~/.claude/skills`, `~/.agents/skills`에 심볼릭링크(entrypoint에서 생성).

### 3.6 프런트 모듈 `src/modules/aidev-router/`
```
index.ts            barrel: AidevRouterBar, AgentCreateCard, useAidevRouting, aidevApi
api.ts              route(), agents CRUD, runs, lessons, engines  (src/shared/api.ts의 fetch 래퍼 사용)
store.ts            useSyncExternalStore: {mode:'auto'|'manual'|'off', last: RouteResult|null, pending: PendingCreate|null, overrides}
useAidevRouting.ts  beforeSend(text, session) → Promise<AidevOptions|null>; onRunEvent(...)
AidevRouterBar.tsx  컴포저 위 한 줄: [범위 D2·implement·risk1] [agent frontend-react 99%] [Claude · sonnet/high] ▾대안 ▾엔진/모델  (모바일: 접힘 칩)
AgentCreateCard.tsx 생성 승인 카드(이름/설명/프롬프트/지식 출처 편집, 승인/거절)
AgentCatalog.tsx    카탈로그 화면(목록·상세: 버전·지식·교훈·실행 통계) — 설정 모달 탭으로 진입
RunFeedback.tsx     assistant 메시지 하단 👍/👎 + "테스트 통과/실패" 표시
```
본체 수정: `useChatComposerState.ts` `handleSubmit` — `sendMessage` 직전 `const aidev = await beforeSend(messageContent, selectedSession)`; `options.aidev = aidev`. `ChatInterface.tsx` — `<AidevRouterBar/>`, `<AgentCreateCard/>` 렌더, 실행 완료 이벤트에서 `onRunEvent`.

### 3.7 agent 생성 (agent-architect)
- 트리거: `/route`가 `decision: create`이고 depth ≥ 2 (D0~1은 `create_queue`에 넣고 범용으로 처리).
- 메타 agent `agent-architect`(시드, 도구: WebSearch/WebFetch/Read만, maxTurns 6): 입력 = 명령 + 기존 카탈로그 요약. 출력 = `<aidev-agent>{name, domain, description, prompt, tools, knowledge:[{title, body, source_url, source_date}], self_check:{task, expected}}</aidev-agent>`.
- 프런트 watcher가 완료된 assistant 메시지에서 블록 파싱 → `AgentCreateCard` → 승인 시 `POST /agents`(+knowledge sourced) → 자가 검증 턴(`self_check.task`를 새 agent로 실행, 결과가 expected에 맞는지 Laya `noul`로 판정) → 통과 시 활성화 → 원래 명령을 새 agent로 자동 전송.
- 실패 시: 카드에 사유 표시, agent는 `active=0`으로 보관.

### 3.8 교훈·지식 축적
- 실행 종료 시 `runs.outcome` 결정: `exit_code≠0` 또는 `tool_errors≥3` 또는 `user_feedback=down` 또는 `reverted` 또는 `test_result=fail` → fail. 👍 또는 test pass → success. 그 외 unknown.
- fail 이면 `lesson-curator` 메타 agent(도구 없음, maxTurns 1)가 그 run의 대화 요약을 받아 `{trigger, rule, engine?}` 후보를 출력 → `lessons(status=candidate)`.
- 후보는 다음 같은 agent 실행 때 주입하지 않는다. **검증 = 같은 trigger로 재실행이 성공(자동)하거나 사용자가 카탈로그에서 승인** → `verified`. 같은 trigger가 3회 이상 → `promoted_to_prompt`(agent 새 버전).
- 지식: `knowledge.expires_at`(기본 90일) 지난 sourced 항목은 `knowledge-refresher`가 출처 재조회 → 변경 시 새 항목 + 구항목 `superseded`.
- 정책 학습: `runs` 집계 → `tier_policy`. 성공률 ≥ 0.9 & n ≥ 10 이면 한 단계 하향 후보, 성공률 < 0.6 & n ≥ 5 이면 상향.

### 3.9 벤치마크 (Laya)
- `deploy/aidev/laya/bench/commands.jsonl`: 한/영 각 60건, 라벨 `{agent, depth, task_kind}`, 12개 분야 균등.
- `bench.py`: accuracy(agent), MAE(depth), accuracy(task_kind), ECE(agent 확률), 분야별 confusion, p50/p95 latency. 결과를 `bench/results/<date>-<release>.json`으로 저장 → 프로젝트 문서에 표로 기록.
- 통과 기준(초기, 미보정): agent accuracy ≥ 0.75, depth MAE ≤ 0.8. 보정 후: accuracy ≥ 0.85, ECE ≤ 0.12.

---

## 4. 체크리스트

각 항목: `[ ]` 미착수 / `[~]` 진행 / `[x]` 완료(릴리스 ID). **서버에서 확인된 것만 [x].**

### B. 판정·선택·실행 (목표: "명령 → 알맞은 agent·엔진·모델로 실제 실행"이 서버에서 동작)
- [ ] B-01 `store.ts`: 3.2의 테이블/컬럼 추가 + 마이그레이션(있으면 건너뜀), `engine_weights` 시드
- [ ] B-02 `store.ts`: 시드 agent 12개 (frontend-react, backend-node, database, devops, tizen-device, android-device, testing, docs, mobile-responsive, security-review, git-workflow, agent-architect) + lesson-curator, knowledge-refresher, generalist. description은 라우팅 기준이므로 한/영 키워드 포함
- [ ] B-03 게이트웨이 `/api/aidev/engines`: accounts.engines ∩ 런타임 auth status(캐시 60s, 실패 시 마지막 값)
- [ ] B-04 게이트웨이 `/api/aidev/route`: 3.1 질문 구성 → Laya → 3.4 등급·엔진 점수 → decision_log 기록 → 3.3 응답. 카탈로그 >20이면 shortlist
- [ ] B-05 게이트웨이 agents CRUD + versions, runs POST/PATCH/GET, decisions PATCH
- [ ] B-06 `aidev-user` CLI: `engines <user> codex|claude,codex`, `default-engine <user> <engine>` (manage-users.ts 확장)
- [ ] B-07 `claude-runtime.provider.js`: `options.aidev` → `sdkOptions.agent/agents/model` (화이트리스트, 길이 제한)
- [ ] B-08 `codex-runtime.provider.ts`: `options.aidev` → `new Codex({config:{developer_instructions, mcp_servers}})`
- [ ] B-09 `runtime/entrypoint.mjs`: `aidev_agents` 볼륨 → `~/.claude/skills`, `~/.agents/skills` 링크; runtime-manager가 볼륨 마운트(ro)
- [ ] B-10 프런트 `aidev-router/` api.ts, store.ts, useAidevRouting.ts(beforeSend) + `useChatComposerState.ts` 훅 연결 (bar 없이도 동작)
- [ ] B-11 서버 검증: 한국어 React 명령 → `/route` → Claude 세션에서 `frontend-react` agent로 실행됨을 런타임 로그(`agents` 옵션)로 확인; Codex 세션에서 `developer_instructions` 적용 확인
- [ ] B-12 Codex 전용 계정 시나리오: 테스트 계정 `engines=codex` → route가 Claude를 제외하는지, 실패 상향이 Codex 내부에 머무는지
- [ ] B-13 `bulk_read` 명령("이 로그 5만 줄 분석해줘")이 두-엔진 계정에서 Codex로 가는지
- [ ] B-14 벤치마크 세트 + `bench.py` 작성, 기준선 측정 결과 기록
- [ ] B-15 릴리스 배포(`relay.sh deploy`) 후 `release.sh status` 정상, 롤백 1회 리허설

**B 완료 기준**: B-11~B-14 서버 로그로 확인, 기준선 수치 기록, 롤백 성공.

### C. 프런트 (목표: 사용자가 판정·선택을 보고 바꿀 수 있고, 모바일에서 쓸 수 있다)
- [ ] C-01 `AidevRouterBar`: 범위 칩(depth·task_kind·risk), agent 칩(확률 바), 엔진/모델 칩, 대안 드롭다운, 수동/자동/off 토글, 불가 엔진 비활성+사유
- [ ] C-02 override 시 `PATCH /decisions/:id` 기록, 이후 같은 세션엔 override 유지
- [ ] C-03 `RunFeedback`: 👍/👎, 테스트 결과 표시 → `PATCH /runs/:id/outcome`
- [ ] C-04 `AgentCatalog`: 목록/상세(버전·지식·교훈·통계), 편집(새 버전), 개인→전역 승격 버튼(관리자)
- [ ] C-05 반응형: 모바일(<640) 바 접힘·한 줄 요약, 태블릿(640~1024) 2열, 데스크탑 전체. 채팅·터미널 화면도 모바일 폭에서 깨지지 않음
- [ ] C-06 dev.nado.work에서 iPhone/iPad/데스크탑 실기기 확인(스크린샷 inbox 회수)

**C 완료 기준**: C-06 3기기 확인, override·피드백이 DB에 기록.

### D. 생성 (목표: 없는 분야를 스스로 만들어 검증하고 쓴다)
- [ ] D-01 `agent-architect` 프롬프트·출력 스키마 확정(3.7), 시드에 포함
- [ ] D-02 프런트 watcher: `<aidev-agent>` 파싱 → `AgentCreateCard`
- [ ] D-03 승인 → `POST /agents`(knowledge sourced 포함) → 자가 검증 턴 → Laya 성공 판정 → 활성화 → 원래 명령 자동 재전송
- [ ] D-04 D0~1 `create_queue` + 동일 분야 3회 반복 시 백그라운드 생성 제안(알림)
- [ ] D-05 Codex 전용 계정에서 생성 전 과정이 Codex로 동작
- [ ] D-06 서버 검증: 카탈로그에 없는 분야(예: "Unity 셰이더") 명령 → 생성 → 검증 → 실행 e2e

**D 완료 기준**: D-06 e2e 로그, 생성된 agent가 다음 명령에서 Laya에 의해 선택됨.

### E. 축적·학습 (목표: 실패가 줄고 지식이 최신으로 유지된다)
- [ ] E-01 `runs.outcome` 결정 로직(3.8) + `lesson-curator` 후보 생성
- [ ] E-02 교훈 검증 게이트(자동 재성공 / 수동 승인), 3회 이상 → 프롬프트 승격(새 버전)
- [ ] E-03 `knowledge-refresher` 주기 작업(서버 cron: 주 1회) + superseded 처리
- [ ] E-04 `tier_policy` 집계 작업(일 1회) + route에 반영, 변경 로그
- [ ] E-05 `engine_weights` 학습(task_kind×engine 성공률·시간), 관리자 편집 API
- [ ] E-06 Laya: `/export/decisions` → 온도 보정 스크립트(서버 GPU) → `aidev_models`에 보정 파라미터 원자 교체 → 벤치마크 재측정
- [ ] E-07 Laya fine-tune 파이프라인(공식 노트북 기반, 서버 iGPU, ≥300건부터) → 가중치 원자 교체 → 벤치마크 비교
- [ ] E-08 서버 검증: 같은 실패를 2회 유도 → 2회째에 교훈이 주입되어 회피되는 것을 로그로 확인

**E 완료 기준**: E-08 확인, 벤치마크 보정 전후 비교표.

---

## 5. 매 릴리스 절차
1. 클라우드: 구현 → `npm run build`/`tsc` 통과 → 커밋 → `bash deploy/aidev/release/pack.sh /mnt/user-data/outputs/rel`
2. `release-<sha>.tgz`를 Mac `ops/releases/`로 전달
3. 사용자: `./relay.sh deploy releases/release-<sha>.tgz` (`changed:` 레인과 재시작 대상 확인)
4. 검증: `./relay.sh status`, 필요 시 `./relay.sh run <cmd>`/`diag` 로그 회수 → 체크리스트 [x] + 릴리스 ID 기록
5. 문제 시 `./relay.sh rollback`
6. 도구 이미지가 바뀌는 경우에만 `laya-image.sh build` / `runtime-image.sh build` (drop-in payload로 별도 실행)

---

## 6. 위험과 대응
| 위험 | 대응 |
|---|---|
| Laya zero-shot 정확도 낮음(문서상 baseline 근처) | description 품질, 벤치마크로 조기 측정, 애매하면 LLM 정밀 분석, 보정→fine-tune |
| 잘못된 교훈 축적 | 후보/검증 분리, 자동 재성공 또는 승인 없이는 주입 금지, 거절 기록 |
| 프롬프트 비대화로 지연·비용 증가 | depth별 길이 상한, 관련도 top-k, 지식은 SKILL.md로 필요 시 로드 |
| Codex `developer_instructions` 동작 차이 | B-08에서 실제 세션으로 확인, 미동작 시 AGENTS.md 주입 대안 |
| 세션 provider 고정 | 새 세션 시작 시 엔진 결정, handoff는 요약 전달로 |
| 사용자 컨테이너 재시작(서버 레인) | `--drain` 롤링, 세션은 볼륨 보존 |
| 관리자 승인 병목(전역 승격) | 개인 범위에서 먼저 효과, 승격은 주기 검토 |

---

## 7. 열린 결정 (기본값으로 진행 중, 바뀌면 여기와 §0 갱신)
- 교훈·지식 범위: 사용자별 축적, 전역 승격은 관리자 승인 → **기본값 채택**
- 계정 엔진 권한 관리: `aidev-user` CLI 옵션 → **기본값 채택**, 관리 UI는 C 이후 검토
- 분야별 엔진 선호 초기값: bulk_read=Codex 우세, 나머지 중립 → **채택**
- 생성 자가 검증의 판정: Laya noul(expected 충족?) + 도구 오류 0 → **채택**, 부족하면 LLM 검토 추가
