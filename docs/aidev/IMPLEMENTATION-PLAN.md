# Nado AI Dev Platform — 구현 계획·체크리스트 (v2, 2026-09-23)

> 이 문서는 구현 중 방향을 잃지 않기 위한 단일 기준 문서다. 모든 작업은 여기의 항목 ID(B-01 …)로 추적하고,
> 완료 시 `[x]`와 릴리스 ID를 적는다. 여기 없는 일을 하게 되면 먼저 이 문서를 고친다.
> 위치: 저장소 `docs/aidev/IMPLEMENTATION-PLAN.md`(원본), 프로젝트 문서 `claude/implementation-plan.md`, Mac `NadoVibe/ops/IMPLEMENTATION-PLAN.md`.
>
> v2 변경: (1) SQLite 유지 결정 (2) **분별·선택이 필요한 모든 지점에 Laya 사용** — 결정 지점 레지스트리 §3.10 (3) **기기별 UI**: 모바일 = 채팅 중심, 태블릿·데스크탑 = IDE 작업대 §3.11 (4) **원격 PC 실행·디버깅·화면 제공** — `aidev-runner`(Rust) §3.12, 단계 F.

---

## 0. 변하지 않는 것 (매 작업 전에 확인)

### 목표
사용자 명령 → **범위·깊이·작업 성격 판정(Laya)** → **전문 agent 선택**(없으면 생성) → **계정이 쓸 수 있는 엔진(Claude Code / Codex)** 중 작업 성격·깊이에 맞는 **모델·추론 강도**로 실행 → 필요하면 **사용자가 지정한 원격 PC에서 실행·테스트·디버깅**하고 그 화면을 그대로 보여줌 → 결과·실패 신호를 기록 → **교훈과 검증된 최신 지식이 agent에 축적**되어 다음 실행이 좋아지는 AI 코딩 플랫폼. 모바일(채팅 중심)·태블릿·데스크탑(IDE 작업대) 대응.

### 원칙 (어기면 안 됨)
1. **원격 서버 AI-PC(100.64.0.9, `ai-turtle`)에서만 운영.** 로컬(Mac)에서 서비스를 돌리지 않는다. Mac은 `ops/relay.sh`로 SSH 중계만, 클라우드 작업공간(`/home/claude/aidev`)은 빌드만.
2. **저장소 연동 없음, 이미지 재빌드 없음.** 배포 = `pack.sh` → `release-<sha>.tgz` → `relay.sh deploy` → 서버 `deploy.sh`가 볼륨 `releases/<sha>/`에 풀고 `current` 원자 교체 → 바뀐 프로세스만 재시작. 도구 이미지(`cloudcli-runtime`, `laya-runtime`)는 도구 버전이 바뀔 때만.
3. **기존 인프라 불변**: NPM(4.conf), Portainer, 인증서, 네트워크(npm_bridge/aidev-control-net/aidev-<user>-net), 시크릿, 사용자 볼륨, `~/aidev/source`. NPM에 무언가를 **추가**하는 것은 §7 결정 후에만.
4. **CloudUI upstream 수정 최소화.** 본체 수정 허용 지점: `server/modules/providers/list/claude/claude-runtime.provider.js`, `server/modules/providers/list/codex/codex-runtime.provider.ts`, `src/modules/chat/hooks/useChatComposerState.ts`, `src/modules/chat/ChatInterface.tsx`, `src/modules/project-workspace/ProjectWorkspaceRoute.tsx`(작업대 분기 1곳), `src/shared/types.ts`(`AppTab` 확장), `vite.config.ts`(mobile 빌드 추가). `src/modules/chat/`에서 비시각 로직을 `src/modules/chat-core/`로 뽑아낼 때는 **이동이 아니라 re-export**(upstream 파일 위치 유지). 나머지는 새 모듈 `src/modules/aidev-router/`, `src/modules/chat-core/`, `src/modules/workbench/`, `src/modules/remote-target/`, 모바일 앱 `src-mobile/`, 서버 `server/modules/aidev-tools/`, 게이트웨이(`deploy/aidev/auth-gateway`), 러너(`deploy/aidev/runner`)에.
5. **Laya는 결정만, 생성은 LLM.** 텍스트가 필요한 모든 것(agent 프롬프트, 지식, 교훈)은 계정이 쓸 수 있는 엔진이 만든다.
6. **분별·선택이 필요한 곳에는 하드코딩 규칙 대신 Laya 질문을 둔다.** 모든 결정 지점은 §3.10 레지스트리에 등록하고 `decision_log`에 남긴다. Laya가 없거나 확신이 낮으면 레지스트리에 적힌 **결정적 fallback**으로 간다(서비스가 멈추지 않는다).
7. **검증되지 않은 지식은 주입하지 않는다.** verified(테스트/승인) · sourced(공식 출처+날짜) · unverified(보관만).
8. **원격 PC는 밖으로만 연결한다.** 사용자 PC에 인바운드 포트를 열지 않는다. 러너가 `wss://dev.nado.work`로 접속하고, 게이트웨이가 브라우저·런타임과 중계한다. 파괴적 명령은 사용자 승인 없이 원격 PC에서 실행하지 않는다.
9. 서버에서 실제로 동작 확인한 것만 "완료". 로그는 `ops/inbox/`로 회수해 읽는다.
10. 비밀번호·토큰은 Claude가 입력하지 않는다. 배포 명령은 사용자가 실행한다.

### 확정된 결정
- 결정 모델: **Laya multilingual** (jev 대체). 서버 iGPU(Radeon 890M, `HSA_OVERRIDE_GFX_VERSION=11.5.0`)에서 `/route` ≈150ms.
- **DB: 게이트웨이 SQLite(`/data/auth.db`, better-sqlite3, WAL) 유지.** 쓰기 주체는 게이트웨이 프로세스 하나뿐이고 런타임·러너는 API로만 기록한다. 접근은 `store.ts` 한 곳으로 제한(라우트에 SQL 금지). 전환 조건(게이트웨이 복제 / 다중 호스트 / 수십만 벡터 검색 / 외부 직접 조회)이 생기면 `store.ts`+마이그레이션만 바꿔 Postgres(+pgvector)로. 전문·벡터 검색은 그때까지 FTS5 + sqlite-vec. 백업: `sqlite3 /data/auth.db ".backup /data/backup/auth-<date>.db"` (서버 cron, 일 1회, 7일 보관).
- 실행 엔진: **Claude Code, Codex.** 계정별 가용 엔진 상이(Codex 전용 / 둘 다).
- 두 엔진 모두 가능할 때 **대량 데이터 분석·읽기 → Codex 가중치 상향.** 그 외 중립, 실행 기록으로 학습.
- 전문 agent = 엔진 중립 정의(프롬프트 + 지식 팩 SKILL.md + 도구 MCP + 교훈). 엔진별 어댑터로 변환.
- 깊이 D0~D4 → 엔진별 모델/effort 표(§3.4). 위험도 높으면 한 단계 상향. 사용자 지정 최우선.
- 전문성↔속도: 맞는 agent 확실 → 사용 / 애매+얕음 → 범용 빠른 경로 / 없음+D0~1 → 범용 처리 후 백그라운드 생성 / 없음+D2+ → 생성 후 실행.
- 교훈·지식은 **사용자 범위**로 축적, 전역 승격은 관리자 승인.
- 계정 엔진 권한은 **`aidev-user` CLI 옵션**으로 관리, 관리 UI는 나중.
- CloudCLI 세션은 provider 고정 → 엔진 선택은 새 세션 시작 시점, 도중 전환은 요약 handoff 새 세션.
- **UI는 두 개의 독립 앱으로 완전히 분리한다(반응형 단일 앱 아님).** `mobile`(`src-mobile/`, 채팅 중심, 경량 번들, 자체 디자인)과 `workbench`(`src/`, 태블릿·데스크탑 IDE 작업대). 같은 저장소, 같은 백엔드·WS·게이트웨이 API를 쓰고, 화면 코드는 공유하지 않는다. 공유는 **비시각 코어**만: `src/shared`(api·types·i18n), `src/modules/chat-core`(메시지·스트리밍·툴콜 모델, 세션 상태), `src/modules/aidev-router`(라우팅 훅·API·스토어). 근거: 현재 단일 번들 `index-*.js` 2.9MB(+ codemirror 648K, xterm 388K, mermaid 580K…)를 모바일이 그대로 받는다; 조건부 렌더링으로는 번들도 디자인도 나뉘지 않는다.
- 작업대는 기존 CloudUI 탭(chat/files/shell/git/browser)을 **패널**로 재사용한다. 새 편집기·터미널을 만들지 않는다(CodeMirror 6·xterm 재사용). 태블릿은 작업대(2패널 모드)로 간다.
- 제공: 게이트웨이가 `/m/*` → `dist-mobile`, `/` → `dist`. 루트 요청이 모바일(`Sec-CH-UA-Mobile: ?1` 또는 UA)이고 override 쿠키 `aidev_ui`가 없으면 302 `/m/<같은 경로>`. 두 앱 모두 "다른 UI로 전환" 메뉴(쿠키 설정). PWA manifest·service worker는 앱별 scope.
- **원격 실행 러너 = Rust 단일 바이너리 `aidev-runner`.** 코드 동기화는 런타임 컨테이너 → 원격 PC 단방향(manifest diff)부터. 원격 PC에서 실행되는 것은 사용자 코드(빌드·실행·테스트·디버그 어댑터)뿐이고 AI 엔진은 항상 서버 런타임에서 돈다.
- AI agent(Claude/Codex)가 원격 PC를 쓰는 통로는 런타임 안의 MCP 서버 `aidev-tools` 하나(`remote_*`, `aidev_decide`). 사용자가 쓰는 통로는 작업대 패널.

### 하지 않을 것 (지금은)
- NPU(XDNA2) 활용, 다중 호스트, 게이트웨이 이중화, admin.nado.work UI, 기존 NadoVibe 연동, 원격 PC → 컨테이너 역방향 편집 동기화(F 3단계 이후).

---

## 1. 현재 상태 (2026-09-23)

| 항목 | 상태 | 근거 |
|---|---|---|
| 서버 릴리스 볼륨 모델 | 완료 | 활성 릴리스 `1da6063f7c55`(게이트웨이 Laya 프록시 포함) |
| Laya 서비스 | 완료, GPU | `aidev-laya`, `device: cuda`, 라우팅 3/3 정답, `/route` p50 ≈150ms |
| 게이트웨이 DB `agents`, `decision_log` | 스키마만 | 커밋 41aee367 (미배포) |
| 게이트웨이 `/api/aidev/route|decide|laya/health` | 배포됨 | Laya 직접 프록시(카탈로그 미연동) |
| provider 훅, 프런트, 생성, 학습, 작업대, 러너 | 미착수 | |

클라우드 저장소 `main` 최신: `a943cce4`(v1 계획) + 이 문서. 다음 릴리스부터 B 단계 반영.

---

## 2. 시스템 구성 (구현 대상 전체 지도)

```
브라우저 — 두 개의 독립 SPA (같은 백엔드)
   ├─ /m/  mobile   (src-mobile → dist-mobile): chat 단일 열, 자체 디자인, ≤600KB 목표 (+ 라우터 칩, RunFeedback, 파일 peek, 결과 카드, 알림)
   ├─ /    workbench(src → dist, CloudUI 포크): src/modules/workbench = 탐색기 | 에디터·diff | 채팅 / 하단: 터미널·실행출력·미리보기·원격화면·디버그
   ├─ 공유(비시각): src/shared, src/modules/chat-core, src/modules/aidev-router
   │  POST /api/aidev/route  {text, sessionId?, engine?}                      ← 전송 직전
   │  POST /api/aidev/decide/:kind {state}                                     ← UI 분별(패널 포커스, 알림 등급…)
   │  chat.send options.aidev = {agent, engine, model, effort, runId, target?}
   │  WS /api/aidev/targets/:id/stream   (원격 화면·pty·디버그 이벤트)
   ▼
aidev-auth-gateway (control/gateway, node:22 + 볼륨)
   ├─ SQLite /data/auth.db: accounts(+engines), agents, agent_versions, knowledge, lessons, decision_log(+kind),
   │                        runs, engine_status, engine_weights, tier_policy, targets, remote_runs
   ├─ /api/aidev/*  (route, decide/:kind, agents, runs, lessons, knowledge, engines, targets, export)
   ├─ laya-questions.ts 레지스트리 ──► aidev-laya (control/laya/app.py, iGPU)  /route /decide /health
   ├─ runner-hub.ts: wss /_runner/ws ◄──(outbound)── 사용자 PC의 aidev-runner (Rust)
   │      └─ /p/<target>/<port>/…  미리보기 터널,  /internal/targets/:id/rpc (런타임용)
   └─ 런타임 인증 상태 질의 ──► aidev-cloudcli-<user>:3001 /api/providers/:p/auth/status
   │
   │  /api/*, /ws, /shell  (기존 프록시)
   ▼
aidev-cloudcli-<user> (cloudcli-runtime 이미지 + 볼륨 current)
   ├─ server: chat-websocket → provider-runtime → claude-runtime.provider.js (Agent SDK)
   │                                             → codex-runtime.provider.ts (codex-sdk)
   ├─ server/modules/aidev-tools: MCP 서버 (aidev_decide, remote_exec/sync/logs/preview/screenshot/debug_*)
   │        └─ 게이트웨이 /internal/targets/:id/rpc 로 러너 호출 (런타임 토큰)
   ├─ ~/.claude/skills, ~/.agents/skills  ← 지식 팩(SKILL.md) 공유 볼륨 aidev_agents (ro)
   └─ 실행 결과 이벤트(complete/exit, tool error, 사용자 피드백) → 프런트 → POST /api/aidev/runs/:id/outcome

사용자 PC (Mac/Windows/Linux, 인바운드 없음)
   └─ aidev-runner: exec(pty) · fs/sync · port(미리보기) · screen(창/디스플레이 캡처) · dap(디버그 어댑터) · device(adb/sdb)
```

---

## 3. 명세 (구현 시 그대로 따를 것)

### 3.1 Laya 판정 질문 (한 번의 `/route` 호출)
**어휘 사전 분류기(실측 후 추가)**: Laya zero-shot의 13지선다 정확도는 힌트 후에도 44%(ko 38/en 52)였다(저자도 "zero-shot 엔진이 아니라 fine-tune용 base"라고 명시). 그래서 agent별 예시 명령(`agent_examples`, 시드 916건 = Claude가 생성한 agent당 한/영 35개씩, 벤치 세트와 분리)로 학습하는 나이브 베이즈 분류기(`classifier.ts`, 한글은 글자 2/3-gram)를 게이트웨이에 두고 Laya 확률과 로그공간에서 융합한다(`LAYA_WEIGHT` 기본 0.35, 예시가 10개 미만인 새 agent는 Laya 쪽 0.85). 홀드아웃 벤치에서 NB 단독 0.78(ko 0.81/en 0.74). 예시는 사용자 override(`PATCH /decisions`)와 agent-architect의 `examples`로 계속 늘어난다. Laya가 죽어도 NB만으로 agent는 라우팅된다. 평가: `POST /api/aidev/route/eval`(Laya/NB/융합 정확도 + α 스윕).
**토큰 예산(실측)**: 선택지 전체가 `head_max_len`(기본 192) 토큰을 나눠 쓴다(선택지당 최대 48, 13개면 ~12). 따라서 agent 선택지는 `name: hint`(hint = 4~7 영단어, `agents.hint`)로만 보내고, 긴 description은 사람·LLM용이다. 질문 지시문은 상태 키를 백틱으로 가리킨다(예: "… in `command`?"). 상태(state)는 남는 예산(max_len 1024)에 들어간다.
`state = {command, project_hint?, recent_files?, targets?}` (1024 토큰 예산 — command 우선, 나머지 잘라냄)

| id | type | criteria / 설명 |
|---|---|---|
| `agent` | choice | 카탈로그 `{name: description}` (≤20, 초과 시 shortlist) |
| `needs_new` | noul | "목록의 어떤 agent도 이 분야에 맞지 않는가" |
| `depth` | score | 0 즉답·조회·한 줄 / 1 한 파일 국소 수정 / 2 여러 파일 기능 / 3 원인불명 디버깅·리팩터링·설계 / 4 아키텍처·마이그레이션·장기 |
| `task_kind` | choice | `bulk_read`(대량 데이터/파일/로그 분석·읽기·요약) · `implement` · `debug` · `refactor` · `design` · `ops` · `explain` |
| `risk` | score | 0 읽기전용 / 1 파일 수정 / 2 파괴적·되돌리기 어려움 |
| `multi_domain` | noul | "둘 이상의 전문 분야에 걸치는가" |
| `remote_action` | choice | `none` · `run` · `test` · `debug` · `build` · `screenshot` — "원격 PC에서 무엇을 해야 하는가" (등록된 대상이 있을 때만 질문) |
| `clarify` | noul | "실행에 필요한 정보가 빠져 있어 한 가지 되물어야 하는가" |

응답에 `latency_ms`, `device`, 각 확률 포함. **LLM 정밀 분석 조건**: `agent` 확률 < 0.5 이거나 `depth` ≥ 2.5 이거나 `multi_domain` > 0.6. **되묻기 조건**: `clarify` > 0.7 이고 depth ≥ 2 (D0~1은 그냥 진행).

### 3.2 데이터 모델 (게이트웨이 SQLite, `store.ts`)
이미 있음: `accounts`, `gateway_sessions`, `agents`, `decision_log`.

```sql
ALTER TABLE accounts ADD COLUMN engines TEXT NOT NULL DEFAULT 'claude,codex';   -- 'codex' | 'claude,codex' | 'claude'
ALTER TABLE accounts ADD COLUMN default_engine TEXT;                            -- NULL = 점수로 결정
ALTER TABLE decision_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'route';         -- §3.10 결정 종류
ALTER TABLE decision_log ADD COLUMN fallback INT NOT NULL DEFAULT 0;            -- Laya 불가/저확신으로 fallback 사용

CREATE TABLE agent_versions (id PK, agent_id REF agents, version INT, prompt TEXT, tools TEXT, model TEXT,
  skills TEXT /*json*/, mcp_servers TEXT /*json*/, changelog TEXT, created_at INT, UNIQUE(agent_id, version));
CREATE TABLE knowledge (id PK, agent_id REF agents, title TEXT, body TEXT /*markdown*/, source_url TEXT,
  source_date TEXT, status TEXT /*verified|sourced|unverified|superseded*/, superseded_by INT,
  expires_at INT, owner_id INT NULL, created_at INT, updated_at INT);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, body, content='knowledge', content_rowid='id');
CREATE TABLE lessons (id PK, agent_id REF agents, engine TEXT NULL, trigger TEXT /*실패 상황*/, rule TEXT /*다음에 할 것*/,
  evidence_run_id INT, status TEXT /*verified|candidate|rejected*/, hits INT DEFAULT 0, owner_id INT NULL,
  promoted_to_prompt INT DEFAULT 0, created_at INT);
CREATE TABLE runs (id PK, user_id INT, session_id TEXT, decision_id INT REF decision_log, agent_id INT NULL, agent_version INT NULL,
  engine TEXT, model TEXT, effort TEXT, depth REAL, task_kind TEXT, risk REAL, target_id INT NULL,
  started_at INT, finished_at INT, exit_code INT, tool_errors INT DEFAULT 0, user_feedback TEXT /*up|down|null*/,
  reverted INT DEFAULT 0, reasked INT DEFAULT 0, test_result TEXT /*pass|fail|null*/, cost_tokens INT,
  escalated_from_run INT NULL, outcome TEXT /*success|fail|unknown*/);
CREATE TABLE engine_status (user_id INT, engine TEXT, authenticated INT, checked_at INT, last_error TEXT, PRIMARY KEY(user_id, engine));
CREATE TABLE engine_weights (task_kind TEXT, engine TEXT, weight REAL, PRIMARY KEY(task_kind, engine));   -- 시드: bulk_read/codex 0.7, bulk_read/claude 0.3, 나머지 0.5/0.5
CREATE TABLE tier_policy (domain TEXT, depth INT, engine TEXT, model TEXT, effort TEXT, success_n INT, fail_n INT, avg_ms INT, PRIMARY KEY(domain, depth, engine));

-- 원격 실행 (§3.12)
CREATE TABLE targets (id PK, user_id INT, name TEXT, platform TEXT /*macos|windows|linux*/, arch TEXT, tags TEXT /*json: ["xcode","android","gpu"]*/,
  description TEXT /*Laya target 선택 기준*/, token_hash TEXT, pairing_code TEXT NULL, pairing_expires INT NULL,
  policy TEXT /*auto|ask|deny*/ DEFAULT 'ask', allowed_roots TEXT /*json*/, capabilities TEXT /*json, 러너 보고*/,
  status TEXT /*online|offline*/, last_seen INT, created_at INT, UNIQUE(user_id, name));
CREATE TABLE remote_runs (id PK, run_id INT NULL, target_id INT REF targets, user_id INT, kind TEXT /*exec|sync|preview|screen|debug|device*/,
  cmd TEXT, cwd TEXT, risk REAL, approved_by TEXT /*auto|user|denied*/, started_at INT, finished_at INT, exit_code INT,
  artifacts TEXT /*json: 로그·스크린샷 경로*/);
```

### 3.3 게이트웨이 API (`/api/aidev/*`, 세션 필수)
| 메서드 | 경로 | 입력 → 출력 |
|---|---|---|
| POST | `/route` | `{text, sessionId?, sessionEngine?, preferEngine?, targetId?}` → `{decision_id, scope:{depth,task_kind,risk,multi_domain,remote_action,clarify}, agent:{name,version,definition}, alternatives[], needs_new, plan:{engine, model, effort, target?, reason[]}, engines:{claude:{allowed,authenticated}, codex:{…}}, latency_ms}` |
| POST | `/decide/:kind` | `{state, options?}` → `{decision_id, answer, confidence, probabilities?, fallback:boolean, latency_ms}` (§3.10 레지스트리의 kind만 허용) |
| PATCH | `/decisions/:id` | `{final_agent?, final_engine?, final_model?, final_target?, final_answer?}` (사용자 override 기록) |
| GET/POST | `/agents` | 목록(전역+개인) / 생성 `{name, domain, description, prompt, tools?, model?, skills?, mcp_servers?}` |
| GET/PUT/DELETE | `/agents/:id` | 상세(현재 버전+지식+교훈 요약) / 수정(새 버전 생성) / 비활성 |
| POST | `/agents/:id/promote` | 개인 → 전역 (관리자만) |
| POST | `/runs` | `{decision_id, session_id, engine, model, effort, target_id?}` → `{run_id}` |
| PATCH | `/runs/:id/outcome` | `{exit_code?, tool_errors?, user_feedback?, reverted?, reasked?, test_result?, cost_tokens?}` |
| GET | `/runs?agent=&limit=` | 기록 |
| POST | `/lessons` / PATCH `/lessons/:id` | 후보 등록(정제 결과) / 검증·거절·승격 |
| POST | `/knowledge` / PATCH `/knowledge/:id` | 등록 / 상태 변경 (`GET /knowledge?q=` FTS5) |
| GET | `/engines` | 계정 가용 엔진 + 인증 상태(캐시 60s) |
| GET/POST | `/targets` | 목록(온라인 여부·capabilities) / 등록 `{name, platform?, tags?, description, policy?}` → `{id, pairing_code(10분)}` |
| PATCH/DELETE | `/targets/:id` | 정책·태그·이름 변경 / 삭제(토큰 폐기, 러너 강제 종료) |
| POST | `/targets/:id/pair/refresh` | 새 pairing_code |
| POST | `/targets/:id/rpc` | 브라우저용 러너 RPC(§3.12 메서드 화이트리스트: fs.list/read, exec.start(pty)…) |
| WS | `/targets/:id/stream` | 러너 이벤트·화면 프레임·pty·DAP 멀티플렉스(브라우저 ↔ 게이트웨이 ↔ 러너) |
| POST | `/targets/:id/approve/:remoteRunId` | `{allow:boolean}` 승인 대기 중인 원격 명령 |
| GET | `/export/decisions?kind=` | Laya 학습용 JSONL |
| ANY | `/p/:targetId/:port/*` | 미리보기 터널(세션 쿠키 필수) |
| WS | `/_runner/ws` | 러너 접속(Bearer target token) |
| POST | `/internal/targets/:id/rpc` | 런타임 MCP용(런타임 토큰 + `X-Aidev-User`), 사용자 소유 target만 |

### 3.4 실행 등급 표 (초기값, `tier_policy`가 비어 있을 때)
| depth | Claude model/effort | Codex model/effort | 장착 |
|---|---|---|---|
| 0 | haiku / low | gpt-5.6-luna / low | 프롬프트만 |
| 1 | sonnet / medium | gpt-5.6-terra / medium | + 교훈 top-3 |
| 2 | sonnet / high | gpt-5.6-terra / high | + 지식 요약(≤2k 토큰) |
| 3 | opus / high | gpt-5.6-sol / high | + 지식 전체, 교훈 전부, 교차 검토 |
| 4 | best(= Fable 5.1, 없으면 최신 Opus) / xhigh | gpt-6-astra / xhigh | + 다중 agent |
- 두 엔진 모두 D4에서 최상위 모델, D3에서 차상위 모델(대칭). `opusplan`(Opus 계획 → Sonnet 실행)은 최상위 등급에서 제외(2026-09-28 수정: 이전 코드는 D4=opusplan이라 Fable 미사용).
- `risk ≥ 1.5` → depth +1. 사용자 지정 model/effort/engine → 그대로.
- **품질 우선 보강**(2026-09-29): (1) 깊이 점수는 소수부 0.35부터 올림(`floor(x+0.65)`), Laya 불가 시 D2. (2) 하한 — 작업 종류별 `KIND_MIN_DEPTH`(debug·refactor·design ≥ D2, implement·ops·bulk_read ≥ D1, explain ≥ D0)와 agent별 `agents.min_tier`(시드: security-review D3, database·devops D2; 카탈로그에서 지정) 중 큰 값까지 올림(generalist 제외). 올린 깊이는 모델뿐 아니라 교훈·지식 주입량에도 적용. (3) agent 지정 모델은 등급 모델보다 강하거나 같을 때만 적용(약하면 무시하고 사유 기록). (4) E-05 하향은 관리자가 켰을 때만(`tier_policy_downgrade`, 기본 꺼짐) + 성공률 ≥90%·10회↑에 👍 절반 이상·재요청 0 필요; 상향·복귀는 항상. (5) 작업대 입력창 모델 표시: 라우팅 중에는 "자동 · <마지막 계획 모델/강도>", 입력창에서 모델·강도를 고르면 라우터 override로 고정("고정 · …", 메뉴 맨 위 "자동"으로 해제); 강도 목록은 엔진 사다리.
- **추론 강도(effort) 상한**(2026-09-29, 계정별 `accounts.effort_cap`): 엔진별로 사용자가 고른다(Claude low~max, Codex low~ultra, 기본 xhigh). D4(실제 적용 등급 기준, tier_policy 반영)는 상한 값으로 실행하고, 다른 등급은 상한을 넘으면 상한으로 낮춘다. 실패 후 escalate는 D4에서 effort를 한 단계씩 상한까지 올린 뒤에 다른 엔진으로 넘긴다(인계 계획도 상한 적용). 사용자가 명령에 직접 지정한 effort는 제한하지 않는다. 설정: 작업대 라우터 바 모드 메뉴, 모바일 설정, `PUT /api/aidev/settings/effort-cap`, `manage-users effort-cap USER claude=max,codex=ultra`.
- 엔진 점수: `w(task_kind, engine)` + `tier_policy 성공률 보정(±0.2)` − `패널티(최근 1h 오류 0.3, 인증 없음 → 제외)`. 동점 → `accounts.default_engine` → claude.
- 세션이 이미 provider를 가지면 엔진은 그 provider로 고정(점수 무시), 모델/effort만 결정.
- `remote_action ≠ none` 이면 agent 프롬프트에 "원격 대상 `<name>`(`<platform>`, tags)에서 `remote_*` 도구로 실행·검증하라"는 지시와 대상 capabilities 요약을 덧붙인다.

### 3.5 엔진 어댑터 (런타임 안)
- 공통 옵션 (프런트 → `chat.send options.aidev`):
  `{ runId, agent: {name, version, prompt, description, tools?, model?, skills?[], mcpServers?}, lessons: string[], knowledgeDigest?: string, engine, model, effort, target?: {id, name, platform, tags, capabilities} }`
- **Claude** (`claude-runtime.provider.js` `mapCliOptionsToSDK`): `aidev` 있으면
  `sdkOptions.agents = { [name]: {description, prompt: prompt + "\n\n## 교훈\n" + lessons + knowledgeDigest + targetNote, tools, model, skills, mcpServers, maxTurns} }`, `sdkOptions.agent = name`, `sdkOptions.model = model`, effort는 기존 `applyClaudeEffort`. `sdkOptions.mcpServers.aidev-tools`는 항상 추가(§3.12).
- **Codex** (`codex-runtime.provider.ts`): `aidev` 있으면 `new Codex({ config: { developer_instructions: <같은 합성 프롬프트>, mcp_servers: {...mcpServers, "aidev-tools": {...}} } })`, `threadOptions.model/modelReasoningEffort`는 기존 경로.
- 화이트리스트 외 필드는 버린다. 프롬프트 합성 최대 길이 = depth별(D0 2k, D1 4k, D2 8k, D3+ 제한 없음).
- 지식 팩(skills): `aidev_agents` 볼륨 `/srv/agents/skills/<agent>/SKILL.md` → 런타임 `~/.claude/skills`, `~/.agents/skills`에 심볼릭링크(entrypoint에서 생성).

### 3.6 프런트 모듈 `src/modules/aidev-router/`
```
index.ts            barrel: AidevRouterBar, AidevRouterChip, AgentCreateCard, RunFeedback, useAidevRouting, aidevApi, useAidevDecide
api.ts              route(), decide(kind,state), agents CRUD, runs, lessons, engines, targets  (src/shared/api.ts의 fetch 래퍼 사용)
store.ts            useSyncExternalStore: {mode:'auto'|'manual'|'off', last: RouteResult|null, pending: PendingCreate|null, overrides, target}
useAidevRouting.ts  beforeSend(text, session) → Promise<AidevOptions|null>  (clarify>0.7 & depth≥2 → ClarifyPrompt 먼저); onRunEvent(...)
useAidevDecide.ts   decide(kind, state) 래퍼 + 결과 캐시(같은 state 30s)
AidevRouterBar.tsx  데스크탑/태블릿 컴포저 위 한 줄: [범위 D2·implement·risk1] [agent frontend-react 99%] [Claude · sonnet/high] [대상 Mac-studio] ▾대안 ▾엔진/모델 ▾대상
(모바일 앱의 AidevRouterChip·ClarifyPrompt·RunFeedback은 src-mobile/ 안에 따로 구현 — 이 모듈에서는 api/store/hooks만 import)
ClarifyPrompt.tsx   되묻기 1문항(인라인, 답하면 원문+답을 합쳐 전송)
AgentCreateCard.tsx 생성 승인 카드(이름/설명/프롬프트/지식 출처 편집, 승인/거절)
AgentCatalog.tsx    카탈로그 화면(목록·상세: 버전·지식·교훈·실행 통계) — 설정 모달 탭으로 진입
RunFeedback.tsx     assistant 메시지 하단 👍/👎 + "테스트 통과/실패" 표시
```
본체 수정(작업대): `useChatComposerState.ts` `handleSubmit` — `sendMessage` 직전 `const aidev = await beforeSend(messageContent, selectedSession)`; `options.aidev = aidev`. `ChatInterface.tsx` — `<AidevRouterBar/>`, `<AgentCreateCard/>`, `<ClarifyPrompt/>` 렌더, 실행 완료 이벤트에서 `onRunEvent`. 모바일 앱은 `chat-core`의 send 훅을 직접 감싸므로 본체 수정 없음.

### 3.7 agent 생성 (agent-architect)
- 트리거: `/route`가 `decision: create`이고 depth ≥ 2 (D0~1은 `create_queue`에 넣고 범용으로 처리).
- 메타 agent `agent-architect`(시드, 도구: WebSearch/WebFetch/Read만, maxTurns 6): 입력 = 명령 + 기존 카탈로그 요약. 출력 = `<aidev-agent>{name, domain, description, prompt, tools, knowledge:[{title, body, source_url, source_date}], self_check:{task, expected}}</aidev-agent>`.
- 프런트 watcher가 완료된 assistant 메시지에서 블록 파싱 → `AgentCreateCard` → 승인 시 `POST /agents`(+knowledge sourced) → 자가 검증 턴(`self_check.task`를 새 agent로 실행, 결과가 expected에 맞는지 Laya `selfcheck.pass`로 판정) → 통과 시 활성화 → 원래 명령을 새 agent로 자동 전송.
- 실패 시: 카드에 사유 표시, agent는 `active=0`으로 보관.

### 3.8 교훈·지식 축적
- 실행 종료 시 `runs.outcome` 결정: `exit_code≠0` 또는 `tool_errors≥3` 또는 `user_feedback=down` 또는 `reverted` 또는 `test_result=fail` → fail. 👍 또는 test pass → success. 신호가 없으면 Laya `outcome.classify`(대화 마지막 요약으로 판정), 확신 < 0.6 → unknown.
- fail 이면 Laya `escalate`로 다음 행동 선택(재시도/등급 상향/엔진 전환/사용자에게) → 상향·전환은 `runs.escalated_from_run`으로 이어 기록. `lesson-curator` 메타 agent(도구 없음, maxTurns 1)가 그 run의 대화 요약을 받아 `{trigger, rule, engine?}` 후보를 출력 → Laya `lesson.accept`(일반화 가능한 규칙인가) 통과 시 `lessons(status=candidate)`.
- 후보는 다음 같은 agent 실행 때 주입하지 않는다. **검증 = 같은 trigger로 재실행이 성공(자동)하거나 사용자가 카탈로그에서 승인** → `verified`. 같은 trigger가 3회 이상 → `promoted_to_prompt`(agent 새 버전).
- 주입 선택: verified 교훈·지식이 top-k(D1 3, D2 5, D3+ 전부)보다 많으면 Laya `inject.select`(임베딩 shortlist → choice)로 이번 명령과 관련 있는 것만.
- 지식: `knowledge.expires_at`(기본 90일) 지난 sourced 항목은 `knowledge-refresher`가 출처 재조회 → Laya `knowledge.stale`(새 출처가 기존 항목을 대체하는가) → 변경 시 새 항목 + 구항목 `superseded`.
- 정책 학습: `runs` 집계 → `tier_policy`. 성공률 ≥ 0.9 & n ≥ 10 이면 한 단계 하향 후보, 성공률 < 0.6 & n ≥ 5 이면 상향.

### 3.9 벤치마크 (Laya)
- `deploy/aidev/laya/bench/commands.jsonl`: 한/영 각 60건, 라벨 `{agent, depth, task_kind, remote_action}`, 12개 분야 균등. `decide-<kind>.jsonl`: §3.10 각 kind 20건.
- `bench.py`: accuracy(agent), MAE(depth), accuracy(task_kind/remote_action), ECE(agent 확률), 분야별 confusion, p50/p95 latency, kind별 accuracy. 결과를 `bench/results/<date>-<release>.json`으로 저장 → 프로젝트 문서에 표로 기록.
- 통과 기준(초기, 미보정): agent accuracy ≥ 0.75, depth MAE ≤ 0.8, 각 decide kind accuracy ≥ 0.7. 보정 후: accuracy ≥ 0.85, ECE ≤ 0.12.

### 3.10 Laya 결정 지점 레지스트리 (`control/gateway/src/laya-questions.ts`)
원칙 6의 구현. 각 항목 = `{kind, where, questions[], buildState(input), threshold, fallback(input), log:true}`. 게이트웨이 `/decide/:kind`가 유일한 입구(프런트·런타임 MCP `aidev_decide`·게이트웨이 내부 모두 이걸 호출). 새 분별이 필요해지면 **여기에 행을 추가**한다.

| kind | 어디서 | type | 질문/선택지 | threshold | fallback |
|---|---|---|---|---|---|
| `route` | 전송 직전 | 복합 §3.1 | — | agent 0.5 | generalist, depth 1 |
| `clarify` | route 안 | noul | 실행에 필요한 정보가 빠졌는가 | 0.7 & depth≥2 | 진행 |
| `remote.action` | route 안(대상 있을 때) | choice | none/run/test/debug/build/screenshot | 0.6 | none(agent가 도구로 판단) |
| `target.select` | 대상 2개 이상 | choice | `{name: description+platform+tags}` | 0.6 | 사용자 기본 대상 |
| `remote.approve` | 런타임 MCP `remote_exec` 직전 | score 0~2 | 0 안전(빌드·테스트·읽기) / 1 파일·설정 변경 / 2 파괴적(삭제·설치·시스템) | ≥1.5 → 승인 요청 | 승인 요청 |
| `inject.select` | 교훈·지식 주입 | shortlist+choice | 이번 명령과 관련 있는 항목 | top-k | 최신순 top-k |
| `selfcheck.pass` | agent 생성 검증 | noul | 결과가 expected를 충족하는가 | 0.7 | 사용자 확인 |
| `outcome.classify` | run 종료(신호 없음) | choice | success/fail/unknown | 0.6 | unknown |
| `escalate` | run fail | choice | retry_same/escalate_tier/switch_engine/ask_user | 0.5 | escalate_tier (다른 엔진 불가면 ask_user) |
| `lesson.accept` | curator 출력 | noul | 일반화 가능한 규칙인가(일회성·환경 특이 제외) | 0.6 | candidate로 보관, 주입 안 함 |
| `knowledge.stale` | refresher | noul | 새 출처가 기존 항목을 대체하는가 | 0.7 | 사람 검토 큐 |
| `handoff` | 엔진 전환 전 | noul | 요약만으로 새 세션이 이어갈 수 있는가 | 0.6 | 사용자에게 요약 확인 |
| `ui.focus` | run 이벤트 후(태블릿·데스크탑) | choice | chat/editor/diff/terminal/run_output/preview/screen/debug | 0.6 | 포커스 변경 없음 |
| `ui.artifact` | run 완료 후 | choice | 열어 보여줄 파일 후보(변경 파일 목록) | 0.5 | 첫 변경 파일 |
| `notify.level` | 모바일·백그라운드 이벤트 | score 0~2 | 0 조용 / 1 배지 / 2 푸시 | — | 1 |
| `device.select` | adb/sdb 기기 2개 이상 | choice | 연결 기기 목록 | 0.6 | 첫 기기 |
| `agent.pick` (MCP `aidev_decide`) | agent 자체 사용 | choice/score/noul | agent가 후보(수정안·파일·접근법) 중 고를 때 | 호출자 지정 | 첫 후보 |

규칙: (a) `probabilities`를 항상 로그에 남긴다(보정·학습용). (b) fallback 사용 시 `decision_log.fallback=1`. (c) 결과가 사용자에게 보이는 kind(`route`, `target.select`, `ui.focus`, `ui.artifact`)는 override를 `PATCH /decisions/:id`로 기록한다. (d) Laya `/health` 실패 시 모든 kind는 즉시 fallback(대기 없음), 30s 후 재시도.

### 3.11 두 개의 UI 앱 (`src-mobile/` 모바일, `src/` + `src/modules/workbench/` 작업대)
**공통 규칙**
- 빌드: `vite.config.ts`에 두 번째 앱 정의(`build:client:mobile` → `dist-mobile`, `base: '/m/'`, `root: src-mobile`). `npm run build`가 둘 다 만든다. 모바일 번들 예산 **≤600KB(gzip 전, 메인 청크)** — CodeMirror·xterm·mermaid·katex·cytoscape 금지(ESLint `no-restricted-imports`로 강제). 코드 하이라이트는 `shiki` 대신 경량 `highlight.js` 코어+언어 8개(≈60KB) 또는 서버 측 하이라이트 응답.
- 공유는 비시각 코어만: `src/shared`(api 래퍼·types·i18n 리소스), `src/modules/chat-core`(WS 프로토콜, 메시지 스트리밍·툴콜·권한 요청 상태 머신, 세션 목록 스토어 — `src/modules/chat`의 훅/유틸에서 re-export로 구성, 파일 이동 없음), `src/modules/aidev-router`(api·store·useAidevRouting·useAidevDecide; 컴포넌트는 앱별). 시각 컴포넌트·라우트·디자인 토큰은 앱별로 따로.
- 제공(게이트웨이 `serveStatic`): `/m/*` → `dist-mobile/`(SPA fallback `/m/index.html`), 그 외 → `dist/`. 루트 진입 시 `Sec-CH-UA-Mobile: ?1` 또는 UA에 `Mobile|Android|iPhone`이고 `aidev_ui` 쿠키가 없으면 302 `/m` + 원래 경로(예: `/session/abc` → `/m/session/abc`). iPad·태블릿 UA는 작업대. 쿠키 `aidev_ui=mobile|workbench`(1년)가 있으면 그대로. 두 앱 모두 설정에 "다른 UI로 전환". 릴리스 간 자산 fallback(`findAssetInOtherReleases`)은 `/m/assets/*`에도 적용. 라우트 이름은 두 앱이 같게(`/session/:id`, `/project/:name`)해서 링크·알림 딥링크를 공용으로 쓴다.
- PWA: `dist-mobile/manifest.webmanifest`(scope `/m/`, standalone, 아이콘 별도), 작업대는 upstream manifest 유지. 푸시는 모바일 앱만 구독.

**모바일 앱 `src-mobile/` (채팅 중심, 자체 디자인)**
- 스택: React 19 + react-router + Tailwind(자체 `tailwind.mobile.config`, 토큰 `src-mobile/theme/tokens.css`: 큰 터치 타깃 44px, safe-area, 하단 고정 컴포저, 시스템 다크모드). 상태는 `chat-core` 훅 + 앱 로컬 store.
- 화면: `Sessions`(프로젝트별 세션 목록, 스와이프 삭제·고정) → `Chat`(트랜스크립트 가상 스크롤, 스트리밍, 툴콜 접힘 카드, 권한 요청 시트, `AidevRouterChip`+bottom sheet, `ClarifyPrompt`, `RunFeedback`, `ApprovalCard`) → 보조 시트: `FilePeek`(읽기 전용, highlight.js, 줄 이동), `DiffPeek`(단일 열 +/− 표시, 자체 렌더러 — `@codemirror/merge` 금지), `RunResultCard`(exit code·마지막 20줄·스크린샷 썸네일·전체 로그 페이지), `ScreenSnapshot`(정지 이미지·새로고침·핀치줌), `TargetsSheet`(온라인 여부·대상 선택), `Catalog`(agent 목록·상세 읽기, 편집은 작업대로 안내), `Settings`(엔진·알림·UI 전환·로그아웃). 터미널·git·파일 트리 화면은 **없음**(작업대 전용); 파일은 검색→peek만.
- 음성 입력: upstream `voice` 모듈의 API만 재사용(버튼은 자체).
- 알림: run 완료·승인 요청·생성 카드는 `notify.level`로 배지/푸시. 앱이 포그라운드면 인라인.
- 성능 목표: LCP < 2.0s(4G), 메인 청크 ≤600KB, 트랜스크립트 1,000 메시지 스크롤 60fps(가상화).

**작업대 앱 `src/` + `src/modules/workbench/` (태블릿·데스크탑, CloudUI 포크)**
- 판정: `useDeviceTier()` → `tablet`(<1280 또는 터치 가로) / `desktop`(≥1280). 모바일 UA가 쿠키로 작업대를 고집하면 `tablet` 모드.
- **데스크탑(IDE 작업대)**: `WorkbenchLayout` = 좌 활동바(탐색기·검색·git·대상·카탈로그) + 좌 사이드(선택된 뷰) + 중앙 **에디터 그룹**(탭: 파일·diff·이미지) + 우 **chat**(라우터 바 포함, 접기 가능) + 하단 **패널**(탭: 터미널·실행 출력·미리보기·원격 화면·디버그·문제). 크기 조절 가능한 split(자체 `SplitPane`, 라이브러리 추가 없음), 배치는 `localStorage['aidev.workbench.<tier>']`(try/catch).
- **태블릿**: 같은 `WorkbenchLayout`의 2패널 모드 — 왼쪽 chat 고정 + 오른쪽 도구 패널 1개(탐색기+에디터 / 미리보기 / 원격 화면 / 터미널 세그먼트), 스와이프 전환, 하단 패널은 시트로. 세로 모드도 작업대(2패널 상하 배치).
- 패널 레지스트리 `panes.ts`: `{id, title, icon, mount: () => ReactNode, tiers: Tier[]}` — `explorer`(file-tree), `editor`(code-editor, 다중 탭), `diff`(git-panel GitDiffViewer 재사용), `terminal`(shell), `git`(git-panel), `browser`(browser-use), `chat`(chat), `run_output`(신규), `preview`(신규, iframe → `/p/<target>/<port>/`), `screen`(신규, canvas 프레임), `debug`(신규, DAP 클라이언트), `targets`(신규, remote-target 모듈).
- 에디터 그룹: 기존 `code-editor`를 탭 컨테이너로 감싼다(파일당 인스턴스, 저장은 기존 API). chat의 파일 경로·`path:line` 링크 클릭 → 에디터 탭 열기·해당 줄. run 완료 후 `ui.artifact`가 고른 파일을 자동으로 연다(설정으로 끔).
- `ui.focus`: run 이벤트(테스트 실패 → terminal/run_output, 미리보기 포트 열림 → preview, 디버그 중단 → debug)마다 Laya로 어느 패널을 앞으로 가져올지 결정. 사용자가 3회 연속 되돌리면 그 kind는 해당 세션에서 off.
- 본체 분기: `ProjectWorkspaceRoute`에서 `<WorkbenchLayout/>` 렌더(기존 `ProjectWorkspaceShell`은 upstream 머지용으로 남기되 사용하지 않음; 설정 `legacy_layout`으로만 진입).

### 3.12 원격 PC 실행·디버깅·화면 (`deploy/aidev/runner/` Rust, 게이트웨이 `runner-hub.ts`, 런타임 `server/modules/aidev-tools/`)
**러너 `aidev-runner`** (crate: tokio, tokio-tungstenite, rustls, serde, portable-pty, xcap(화면), blake3, ignore(gitignore), notify(감시)):
- 설치: 단일 바이너리 + `aidev-runner pair <code> --gateway https://dev.nado.work` → 토큰 저장(`~/.aidev/runner.toml`, 0600; macOS는 keychain 선택). `aidev-runner start`(포그라운드) / `install-service`(launchd·systemd·Windows 서비스). 배포: Linux·Windows는 클라우드 cross-build, macOS는 Mac에서 `ops/runner/build.sh`(cargo) — §7.
- 접속: `wss://dev.nado.work/_runner/ws`, `Authorization: Bearer <token>`, 15s heartbeat, 재접속 backoff. 접속 시 capabilities 보고: os/arch/hostname, 셸, 도구 버전(node/python/java/go/rustc/xcode/adb/sdb/docker), 디스플레이 목록, 연결 기기(adb/sdb), allowed_roots.
- 프로토콜: JSON-RPC 2.0 텍스트 프레임 + 바이너리 프레임(`[streamId u32][payload]`). 메서드:
  `exec.start{cmd, args, cwd, env, pty:bool, cols, rows}` → `{streamId}`; `exec.write`, `exec.resize`, `exec.signal`; 이벤트 `exec.exit{code}`; 출력은 바이너리 스트림.
  `fs.list/stat/read/write/hash{path}` (allowed_roots 안만), `sync.manifest{root, ignore}` → `[{path,size,mtime,blake3}]`, `sync.apply{root}` + tar 스트림(추가·변경), `sync.delete{paths}`.
  `port.list`, `port.open{port}` → 게이트웨이가 `/p/<target>/<port>/`로 매핑; 게이트웨이가 `http.request{streamId, method, path, headers}` + body 스트림을 보내면 러너가 `127.0.0.1:port`로 요청하고 응답 스트림 반환(WebSocket 업그레이드는 `ws.open`으로 터널).
  `screen.list` → 프로그램 창 목록(러너 0.7+, 0.5/0.6은 디스플레이); `screen.start{window, mode:video|jpeg, fps, maxWidth, bitrate}` → 그 창의 H.264(러너 내장 OpenH264)/JPEG 프레임 스트림(변화 없으면 프레임 생략); `screen.key`(다음 프레임 키프레임); `screen.stop`; `screen.shot{window|query}` → 1장. 콘솔 프로그램은 창 영상 대신 `exec`(pty) 스트림을 터미널로 보여 준다(F-07c).
  `dap.start{adapter: "js-debug"|"debugpy"|"codelldb"|"custom", command, cwd}` → DAP 메시지를 텍스트 프레임으로 양방향 프록시; `dap.stop`.
  `device.list` (adb devices / sdb devices), `device.shot{serial}`(adb exec-out screencap), `device.mirror.start{serial}`(adb screenrecord h264 → 바이너리 스트림; 브라우저 WebCodecs 디코드) — 2단계.
- **게이트웨이 `runner-hub.ts`**: targetId → 소켓 맵, 브라우저 `/targets/:id/stream`과 런타임 `/internal/targets/:id/rpc`를 러너로 멀티플렉스. 미리보기 `/p/:target/:port/*`: 세션 쿠키 확인 → `http.request` 터널. HTML 응답에는 `<base href="/p/<t>/<p>/">` 삽입 + `Location`·`Set-Cookie Path` 재작성. WS 업그레이드(HMR) 터널. 최대 동시 스트림·프레임 크기 제한(프레임 ≤ 300KB, 10fps).
- **런타임 MCP `aidev-tools`** (`server/modules/aidev-tools/`, `browser-use-mcp.ts`와 같은 stdio MCP 패턴; 두 엔진에 `mcpServers`로 등록): 도구 `aidev_decide{kind, state, options}`, `remote_targets`, `remote_sync{target, project, dryRun}`, `remote_exec{target, cmd, cwd, timeout, pty:false}` → `{exitCode, stdoutTail, logPath}` (실행 전 Laya `remote.approve`; ≥1.5 또는 target.policy=ask면 게이트웨이에 승인 대기 → 프런트 `ApprovalCard`), `remote_logs{remoteRunId, from}`, `remote_preview{target, port}` → `{url}` (프런트 preview 패널 자동 열림), `remote_screenshot{target, display|window}` → 이미지(agent가 화면을 보고 판단), `remote_debug_start{target, adapter, program, breakpoints[]}` / `remote_debug_continue|step|eval` → 중단 지점·변수(agent 자율 디버깅), `remote_device_list`, `remote_device_shot`.
- **동기화 모델**: 런타임 `~/projects/<p>` → 대상 `~/aidev-work/<p>/`. `.gitignore`+`.aidevignore` 존중, `node_modules`·빌드 산출물 제외(대상에서 설치). manifest diff로 변경분만 tar 스트림. 결과물(로그·리포트·스크린샷)은 러너가 `.aidev/remote/<remoteRunId>/`로 되돌려 런타임에서 읽게 한다. 역방향 전체 동기화는 3단계.
- **보안**: 토큰 = 32B 랜덤, DB에는 해시. `allowed_roots` 밖 접근 거부. env는 명시 전달분만(러너 프로세스 env 미상속 옵션). `remote.approve` + `targets.policy`. 모든 원격 실행은 `remote_runs`에 기록(cmd·cwd·승인자·exit). 러너 삭제 시 즉시 소켓 종료. 화면 캡처는 사용자가 대상 등록 시 명시 동의(체크박스, DB `capabilities.screen=true`).
- **프런트 `src/modules/remote-target/`**: `TargetsPanel`(등록·pairing 코드 표시·온라인 상태·capabilities·정책), `RunOutputPane`(xterm 읽기 전용 스트림), `PreviewPane`(iframe + 주소·새로고침·기기 프리셋 폭), `ScreenPane`(canvas, fps/품질, 스냅샷 저장), `DebugPane`(DAP 클라이언트: 브레이크포인트 gutter ↔ code-editor, 콜스택·변수·콘솔), `ApprovalCard`(chat 안, 명령·위험도·허용/거부).

---

## 4. 체크리스트

각 항목: `[ ]` 미착수 / `[~]` 진행 / `[x]` 완료(릴리스 ID). **서버에서 확인된 것만 [x].**
순서: **B → C → F → D → E**. F-01~F-05(실행·동기화·MCP)는 C와 병행 가능. D·E는 B·F가 만드는 신호(run, remote_runs)를 쓰므로 뒤.

### B. 판정·선택·실행 (목표: "명령 → 알맞은 agent·엔진·모델로 실제 실행"이 서버에서 동작)
로컬 검증 도구: `deploy/aidev/auth-gateway/test/smoke.sh`(mock Laya·runtime으로 게이트웨이 API 38개 체크), `deploy/aidev/release/local-platform.sh`(실제 CloudCLI 런타임 + 게이트웨이 + 두 앱 + mock 매니저/Laya 로컬 에뮬레이션; `scripts/ui/*.mjs`로 스크린샷·모바일 전송 흐름 확인 — 런타임 로그에 `aidev routing` 확인됨). 백업 포인트: `deploy/aidev/release/checkpoint.sh <ID> "<msg>"` → 태그 `ckpt/<ID>-<날짜>` + bundle + origin push.
- [~] 구현·로컬검증 완료(smoke 30/30), 서버 확인 대기 — B-01 `store.ts`: 3.2의 테이블/컬럼 추가(`decision_log.kind/fallback`, `knowledge_fts`, `targets`, `remote_runs` 포함) + 마이그레이션(있으면 건너뜀), `engine_weights` 시드, 백업 cron 스크립트 `deploy/aidev/release/db-backup.sh`
- [~] 구현 완료(시드 16: 13 라우팅 + 3 메타), 서버 확인 대기 — B-02 `store.ts`: 시드 agent 12개 (frontend-react, backend-node, database, devops, tizen-device, android-device, testing, docs, mobile-responsive, security-review, git-workflow, agent-architect) + lesson-curator, knowledge-refresher, generalist. description은 라우팅 기준이므로 한/영 키워드 포함
- [~] 구현·로컬검증 완료, 서버 확인 대기 — B-03 게이트웨이 `/api/aidev/engines`: accounts.engines ∩ 런타임 auth status(캐시 60s, 실패 시 마지막 값)
- [~] 구현·로컬검증 완료(18 kind, fallback 검증), 서버 확인 대기 — B-04 게이트웨이 `laya-questions.ts` 레지스트리(§3.10 전 kind, fallback 포함) + `/api/aidev/decide/:kind` + health 실패 시 즉시 fallback
- [~] 구현·로컬검증 완료, 서버 확인 대기 — B-05 게이트웨이 `/api/aidev/route`: 3.1 질문(+clarify, remote_action) → Laya → 3.4 등급·엔진 점수 → decision_log 기록 → 3.3 응답. 카탈로그 >20이면 shortlist
- [~] 구현·로컬검증 완료, 서버 확인 대기 — B-06 게이트웨이 agents CRUD + versions, runs POST/PATCH/GET, decisions PATCH, knowledge FTS 검색
- [~] 구현 완료(engines/default-engine/role), 서버 확인 대기 — B-07 `aidev-user` CLI: `engines <user> codex|claude,codex`, `default-engine <user> <engine>` (manage-users.ts 확장)
- [~] 구현·로컬검증 완료(stdio MCP → 로컬 API → 게이트웨이 /internal/aidev, runtime JWT 검증), 서버 확인 대기 — B-08 런타임 `server/modules/aidev-tools/` MCP 서버 골격 + `aidev_decide` 도구(게이트웨이 `/decide/:kind` 호출, 런타임 토큰) — remote_* 는 F에서
- [~] 구현 완료(preset append + agents 등록 + aidev-tools MCP 주입, 단위테스트 4/4), 서버 확인 대기 — B-09 `claude-runtime.provider.js`: `options.aidev` → `sdkOptions.agent/agents/model` + `mcpServers.aidev-tools` (화이트리스트, 길이 제한)
- [~] 구현 완료(developer_instructions + mcp_servers config), 서버 확인 대기 — B-10 `codex-runtime.provider.ts`: `options.aidev` → `new Codex({config:{developer_instructions, mcp_servers}})`
- [ ] (D-03으로 이동: 지식 팩 SKILL.md 볼륨은 agent 생성 단계에서 함께 구현; 현재는 knowledge_digest 프롬프트 주입으로 대체) B-11 `runtime/entrypoint.mjs`: `aidev_agents` 볼륨 → `~/.claude/skills`, `~/.agents/skills` 링크; runtime-manager가 볼륨 마운트(ro)
- [~] 구현·typecheck/lint 통과, 서버 확인 대기 — B-12 프런트 `aidev-router/` api.ts, store.ts, useAidevRouting.ts(beforeSend, clarify), useAidevDecide.ts + `useChatComposerState.ts` 훅 연결 (bar 없이도 동작)
- [~] B-13 서버 검증(2026-09-24, 639d88db): "react로 간단한 todo 앱 만들어봐" → 라우팅 로그는 찍혔으나 (1) 런타임 Claude OAuth 만료로 Codex plan이 나왔는데 워크벤치가 세션을 UI provider(Claude)로 먼저 만들어 Codex 모델을 Claude 세션에 적용 → 실패, (2) 어휘 prior가 generalist 예시에 잠식돼 create 경로(agent-architect)로 빠짐. 수정: 라우팅→세션 생성 순서(plan.engine으로 생성), generalist 예시 제외+저신뢰 규칙, create는 어휘 확신 <0.6일 때만, `plan.engine_error` 표시, `relay.sh claude-token`(setup-token 장기 토큰 설치). 재검증 대기
- [ ] B-13 서버 검증: 한국어 React 명령 → `/route` → Claude 세션에서 `frontend-react` agent로 실행됨을 런타임 로그(`agents` 옵션)로 확인; Codex 세션에서 `developer_instructions` 적용 확인; agent가 `aidev_decide`를 호출한 로그 확인
- [ ] B-14 Codex 전용 계정 시나리오: 테스트 계정 `engines=codex` → route가 Claude를 제외하는지, 실패 상향이 Codex 내부에 머무는지
- [~] B-15 `bulk_read` 명령("이 로그 5만 줄 분석해줘")이 두-엔진 계정에서 Codex로 가는지
  - 서버(500d39e3, 실제 Laya): task_kind=debug(0.38)로 오판 → task_kind에도 어휘 prior 도입(`agent_examples.task_kind` 라벨 916건, NB, `LAYA_KIND_WEIGHT` 0.35 융합; 벤치 어휘 단독 0.62, bulk_read 재현율 4/4). 다음 verify에서 `kind.*` 수치 확인
- [x] B-16 벤치마크 세트(§3.9, decide kind 포함) + `bench.py` 작성, 기준선 측정 결과 기록
  - 기준선(서버 실제 Laya, 2026-09-23, 126 held-out): agent Laya 단독 0.429 / 어휘 NB 0.778 / 융합 0.833 (ko 0.859, en 0.806); α sweep 0→0.778, 0.2→0.833, 0.35→0.833, 0.5→0.802, 0.65→0.786, 0.8→0.651, 1→0.429 → `LAYA_WEIGHT` 기본 0.3(plateau 중앙)
- [ ] B-17 릴리스 배포(`relay.sh deploy`) 후 `release.sh status` 정상, 롤백 1회 리허설, DB 백업 파일 확인

**B 완료 기준**: B-13~B-16 서버 로그로 확인, 기준선 수치 기록, 롤백 성공.

### C. 두 개의 UI (목표: 모바일 앱은 채팅으로 끝까지 쓸 수 있고, 작업대는 IDE처럼 코드를 보며 작업한다)
- [~] 구현·로컬검증 완료(메인 청크 231KB gz 73KB, 금지 라이브러리 0) — C-01 빌드 분리: `vite.config.ts` 두 번째 앱(`src-mobile`, base `/m/`, `dist-mobile`), `npm run build`가 둘 다 생성, `pack.sh`·manifest에 `dist-mobile` 포함, 모바일 금지 import ESLint 규칙, 번들 예산 검사 스크립트(`scripts/check-bundle.mjs`, >600KB면 빌드 실패)
- [~] 구현·smoke 검증 완료 — C-02 게이트웨이 `serveStatic`: `/m/*` → `dist-mobile`, 루트 UA/쿠키 판정 302, `aidev_ui` 쿠키, `/m/assets` 구 릴리스 fallback — 서버 검증: iPhone UA로 `/` → `/m/`, 쿠키로 고정 시 작업대
- [~] 구현 완료(chat-core 배럴: sessionStore·realtime·auth·ws·api; WebSocketContext는 auth 컨텍스트 직접 import) — C-03 `src/modules/chat-core/`: 기존 chat 훅·유틸 re-export 정리(WS 프로토콜·스트리밍 상태·세션 스토어·권한 요청), 시각 의존 0 확인(`tsc` + import 검사). `aidev-router` 컴포넌트/로직 분리
- [~] 구현 완료(Login·Sessions·Chat 스트리밍·툴카드·권한 시트·라우터 칩·프로젝트 선택·Settings), 실기기 확인 대기 — C-04 모바일 앱 골격: 라우팅(`/m/session/:id`, `/m/project/:name`), 로그인(게이트웨이 세션 재사용), 테마 토큰, `Sessions`·`Chat`(스트리밍·툴콜 카드·권한 시트) — 서버 검증: iPhone에서 명령 1건 완주
- [ ] C-05 모바일 보조 시트: `AidevRouterChip`+sheet, `ClarifyPrompt`, `RunFeedback`, `FilePeek`(highlight.js), `DiffPeek`(자체 렌더러), `RunResultCard`, `ScreenSnapshot`, `TargetsSheet`, `Catalog`(읽기), `Settings`(UI 전환 포함)
- [~] C-06 모바일 PWA(manifest scope `/m/`, SW, 아이콘) + `notify.level` 배지/푸시 + 성능 측정(Lighthouse 모바일 4G: LCP<2.0s, 메인 청크 크기 기록)
  - 푸시 구현(2026-09-28): 게이트웨이 `push.ts`(web-push, VAPID 키 DB 보관, 404/410 구독 정리) + `/api/aidev/push/key|subscribe|unsubscribe|test`; 런타임이 Claude 토큰 만료일·인증 거부를 `/internal/aidev/claude-auth`로 보고 → 게이트웨이가 6시간마다 확인해 만료 30·7·1일 전·만료 시·인증 거부 시 각 1회 푸시(런타임을 깨우지 않음). 알림 탭 → `/m/settings?login=claude` → 로그인 시트. 모바일 설정 "푸시 알림" 토글·테스트 알림, iOS는 홈 화면 설치 앱에서만(안내 표시). 로컬: 로컬 HTTPS 푸시 엔드포인트로 aes128gcm 복호화·VAPID 헤더·일정·410 정리 검증, smoke +5. 서버 확인 대기: 게이트웨이 컨테이너의 푸시 서비스(FCM/APNs web push) 외부 접속, 실기기 수신. 남음: notify.level 배지, Lighthouse
- [~] 구현 완료(활동바·사이드·에디터 그룹·하단 패널·chat, 태블릿 2패널, 배치 저장), 실기기 확인 대기 — C-07 작업대 `useDeviceTier()` + `workbench/`: `SplitPane`, `WorkbenchLayout`(활동바·사이드·에디터 그룹·chat·하단 패널), 태블릿 2패널 모드, 배치 저장/복원, `panes.ts`에 기존 모듈 6개 장착, `ProjectWorkspaceRoute` 분기
- [~] C-07b 앱 안 Claude 구독 로그인(2026-09-28): 런타임이 `claude setup-token`을 내부 pty로 구동 → 로그인 URL을 UI에 전달 → 사용자가 붙여넣은 코드 입력 → 1년 토큰을 런타임이 직접 저장(`~/.cloudcli/aidev-claude-token.json` 0600 + process.env + `~/.claude/settings.json` env). 설정(Agents→Claude 로그인)·라우터 바 "Claude 로그인 만료 · 다시 로그인"·모바일 설정/칩에서 같은 흐름. 실제 턴 인증 실패는 기록되어 probe가 "만료"로 보고(라우터·UI 즉시 반영), 만료 30일 전부터 D-n 알림, 게이트웨이 `/engines?refresh=1`. Mac `setup-token`·`relay.sh claude-token` 불필요. 로컬: 실제 CLI로 URL 캡처·잘못된 코드 거부 확인, 대체 CLI로 저장·상태·UI(작업대·모바일) e2e 확인. 부수: E-01에서 생긴 providers↔aidev-tools import 순환(providers 테스트 11개 실패) 해소
- [~] C-07c 데스크탑 배치 변경(2026-09-28): 채팅이 가운데 기본 열, 코드 패널(에디터 그룹+터미널/브라우저/작업)은 오른쪽으로 옮기고 필요할 때만 표시 — 파일 열기·터미널 켜기 시 나타나고 마지막 탭을 닫으면(터미널 꺼짐 상태) 사라짐, 액티비티 바 "코드 패널"/"터미널 패널" 토글과 패널 머리글 닫기 버튼, 숨겨도 탭·터미널 세션 유지(마운트 유지)
- [~] C-07a 좌측 내비 단일화(2026-09-27): 워크벤치 활성 시 CloudCLI 도킹 사이드바 제거 → 세션 목록은 데스크탑 액티비티 바 첫 뷰 "세션"(항상 마운트: 설정·새 프로젝트 모달 보유), 태블릿은 헤더 버튼 슬라이드 드로어(백드롭/Esc/세션 선택 시 닫힘); `Sidebar embedded` 변형(로고·GitHub Star·Report Issue·Community·버전 푸터·접기 버튼 제거); 떠 있는 빠른설정 핸들 제거 → 액티비티 바/태블릿 헤더의 빠른설정·설정 버튼; `aidev.legacy_layout=1`로 원복. 로컬 1440/1024/820 확인, 서버 확인 대기. 남은 정리: "Choose Your AI Assistant" provider 선택기(라우터 자동 모드와 중복) 처리 방식 결정
- [~] 다중 탭·닫기·chat 링크 열기 구현, diff 탭(merge)은 CodeEditor 내장 diff 재사용, 실기기 확인 대기 — C-08 작업대 에디터 그룹: 다중 탭, dirty 표시, chat `path:line` 링크 → 탭, diff 탭(`@codemirror/merge`), 이미지 탭
- [~] 라우터 바(범위·agent·엔진/모델 칩, 대안·엔진 드롭다운, 모드, override 기록, 👍/👎) 구현·로컬 에뮬레이션에서 확인; ClarifyPrompt·AgentCatalog 남음 — C-09 작업대 `AidevRouterBar`(범위·agent·엔진/모델·대상 칩, 대안, 수동/자동/off, 불가 엔진 사유), `ClarifyPrompt`, `RunFeedback`, `AgentCatalog`(편집·새 버전·승격), override `PATCH /decisions/:id`
- [ ] C-10 `ui.focus`·`ui.artifact` 연결(작업대): run 이벤트 → Laya → 패널 포커스/파일 자동 열기, 3회 되돌림 시 off
- [ ] C-11 실기기 확인(스크린샷 inbox 회수): iPhone 세로(모바일 앱), iPad 가로·세로(작업대 태블릿 모드), 데스크탑(작업대). 두 앱에서 같은 세션 딥링크가 열림

**C 완료 기준**: C-11 3기기 확인, 모바일 메인 청크 ≤600KB 기록, override·피드백이 DB에 기록, 데스크탑에서 파일 열기·diff·터미널·chat이 한 화면에서 동작.

### 라우팅 보정 (2026-09-29): 전문 agent 판정 (specialist judge)
- 문제(서버 실측): Laya·어휘 prior는 카탈로그 안에서 **상대** 순위만 매겨, 맞는 전문가가 없어도 1등이 선택됨 — Unity 셰이더→testing, Verilog→docs, SwiftUI→frontend-react, 퀀트 백테스트→testing(p=0.99), Kotlin Compose→mobile-responsive(android-device가 있는데도), sw_vers→testing. needs_new(Laya)는 0.03~0.47로 생성이 거의 일어나지 않았고, `create_background`는 클라이언트에서 아무것도 만들지 않았음.
- 해결: 명령마다 **LLM 판정**(런타임 `/api/aidev-tools/specialist-judge`, Claude haiku → 실패 시 Codex mini, 도구 없음·대화에 기록 안 함)이 Laya와 **병렬로** "기존 agent 중 이 명령의 핵심 기술·분야를 명시적으로 전문으로 하는 agent가 있는가"를 절대 기준으로 판정: 있으면 그 agent(fit≥0.6), 사소하거나 분야 없는 요청(짧은 질문·지정된 셸 명령 실행·이름 변경)은 generalist, 없으면 **create**(판정이 제안한 이름·분야·기술을 agent-architect에 전달). 비슷한 이름의 근접 분야(React↔SwiftUI, testing↔퀀트)는 적합 아님을 규칙·예시로 명시.
- 속도·학습: 같은 명령은 캐시(30일, 카탈로그 변경 시 무효), judge가 확인한 명령은 그 agent의 예시(source=judge)로 추가되어 어휘 prior가 학습, 어휘 prior ≥0.9이고 judge 확인 예시와 cosine ≥0.8이면 LLM 생략. judge 불가 시: 애매(<0.5)하고 D≥2면 best match 대신 create.
- 생성 자동화: 라우팅 "자동" 모드에서는 architect 초안을 자동 승인 → agent 생성 → 원래 명령을 새 agent로 재전송(카드는 결과 표시로 남음). "확인 후" 모드는 기존처럼 승인 대기.
- 검증: 실제 haiku 판정 14개 중 13개 정답(Unity·Verilog·Blender·SwiftUI·Solidity·퀀트 → 새 전문가, React·PostgreSQL·Tizen·Express·Kotlin → 해당 전문가, 이름 변경·sw_vers → generalist), smoke +4(생성·근접 분야 불사용·캐시·generalist), 실제 e2e "Verilog UART" → verilog-hdl 생성 → 재전송 → 모듈 코드(73초). 지연: 판정 1회 약 8~15초(작업 환경 기준) — 서버 실측 후 최적화(상주 판정 세션) 검토
- 서버 실측(0bce93bf, 전문 agent 12개, 명령 12개): 판정 12/12 의도대로(Unity·Verilog·Blender·SwiftUI·Solidity·퀀트·Helm → 새 전문가 제안, React→frontend-react, PostgreSQL→database, Tizen→tizen-device, Kotlin Compose→android-device, sw_vers→generalist). 단 지연 6~36초(중앙값 약 10초)이고 2건(Kotlin 32초·Helm 36초)은 30초 한도를 넘어 판정이 버려지고 Kotlin이 generalist로 떨어짐. 원인: CLI 기본 adaptive thinking(출력 토큰 600~950개 중 대부분이 사고, 최대 74초 폭주).
- 최적화 R-JUDGE-2 (2026-09-29): ① 판정은 thinking 끔 + 스트리밍 + 첫 완결 JSON에서 즉시 중단(Codex는 reasoning low) — 벤치 18개: 정확도 18/18 동일, 중앙값 7.7초→2.8초, 최대 74초→4.1초 ② **입력 중 사전 판정**: 작성 중 0.9초 멈추면(8자 이상, 슬래시 명령 제외) `/api/aidev/route/prejudge`가 판정을 시작해 캐시 — 전송 시 대부분 캐시 적중(대기 0) ③ 같은 명령의 판정은 게이트웨이·런타임 모두 1회만 실행(진행 중이면 합류), 사용자당 동시 사전 판정 3개 ④ 전송은 최대 20초(`AIDEV_JUDGE_WAIT_MS`)만 기다리고, 늦은 판정도 도착하면 캐시되어 다음 전송에 사용(런타임 호출 한도 60초). 응답 `judge.wait_ms`·`judge.prejudged`로 확인. smoke +7(사전 판정 시작·합류·캐시·짧은 입력·지연 판정 폴백·늦은 판정 캐시)

### 수정 (2026-09-29, a3e04726): 대화 내용 검색이 서버에서 항상 실패하던 문제
- 원인: 릴리스 볼륨이 의존성을 `npm ci --ignore-scripts`로 설치 → `@vscode/ripgrep`의 postinstall(GitHub에서 rg 내려받기)이 실행되지 않아 `bin/rg` 없음 → 검색 시 `spawn … rg ENOENT` → 제목 결과 뒤 "Search failed". 작업 환경의 서버 테스트 1건 실패도 같은 원인
- 수정: 패키지 rg가 있으면 사용 → 없으면 PATH의 `rg` → 없으면 Node 스트리밍 검색(대소문자 무시, 청크 경계 처리). 테스트 추가(rg 없는 환경, 256KiB 경계에 걸친 일치; 경계 처리를 빼면 실패함을 확인). 서버 확인: "sw_vers"·"macOS 15.7"(제목에 없는 본문) 검색 결과 반환, 약 0.45초, 없는 단어는 결과 0·오류 없음
- 런타임 이미지 Dockerfile에 `ripgrep` 추가(다음 이미지 재빌드 때 반영 → 그때부터 rg 경로 사용)

### 진행 방식 (2026-09-29 사용자 결정)
- 남은 단계는 구현 → 기본 검증(로컬 테스트·smoke + 서버 배포 후 API/화면 기본 확인)까지만 하고 다음 단계로 넘어간다. 실사용 검증(Mac 러너 업데이트가 필요한 흐름, agent 생성 e2e, 실기기 등)은 전체 구현 후 최종 테스트에서 한꺼번에 한다.

### 수정 (2026-09-30): 서버 테스트가 가끔 실패하던 문제 (`agent.routes.test.ts`, "Unable to deserialize cloned data")
- 원인: Node 22 테스트 실행기가 각 테스트 파일의 stdout을 직렬화된 보고 프레임 + 콘솔 텍스트로 읽는데, 프레임 크기를 부호 있는 32비트로 계산함. 콘솔 텍스트가 프레임 바로 뒤에 같은 파이프 읽기로 붙어 오고 그 텍스트 셋째 바이트가 0x80 이상(줄 맨 앞 이모지 "🔄 Cloning…", "✅ …")이면 크기가 음수가 되어 텍스트를 프레임으로 해석 → 파일 전체 실패. 파이프가 읽기를 나누는 방식에 따라 간헐적(전체 실행 5회 중 3회 실패)
- 확인: 실패한 실행의 자식 stdout을 그대로 저장해 보니 바이트는 정상이었고, Node 파서 코드를 그대로 옮겨 같은 바이트를 넣으면 같은 오류 재현, 콘솔 텍스트를 ASCII로 바꾸거나 텍스트가 새 읽기에서 시작하면 정상
- 수정: `npm test`가 모든 테스트 프로세스에 `server/test-support/console-to-stderr.mjs`를 미리 불러 콘솔 출력을 stderr로 보냄(실행기가 해석하지 않음, 로그는 그대로 보임). 이후 전체 실행 7회 연속 483개 모두 통과

### 판단 원칙 (2026-09-29 사용자 결정): 정확도 우선, 비정상적으로 느릴 때만 속도
- agent 선택·판단·확률 작업에서 정확도와 속도가 충돌하면 **정확도**를 택한다. 단 정확도를 위한 방법이 비정상적으로 느리면 속도를 택한다.
- 기준(라우팅 1회, 사용자가 기다리는 시간): 전송 후 대기 p95 ≤ 5초는 정상, 10초 초과가 반복되면 비정상 → 더 빠른 경로로 전환(현재 판정 대기 상한 20초는 안전장치). 입력 중 사전 판정으로 가려지는 시간은 대기에 넣지 않는다.
- 현재 적용: 최종 전문 agent 판정은 LLM judge(서버 실측 22/22, 2~4초). Laya는 범위·위험·승인·교훈 등 판단에 사용하고, agent 판정은 아래 실험 결과대로 학습으로 judge 수준에 도달하기 전까지 대체하지 않는다.

### Laya 전문 agent 판정 실험 (2026-09-29, 82b497b2, `bench.py --experiments`, 172개: 전문 판정 46 + 라우팅 126)
- Laya 입력 구조(laya 0.3.5 소스): 질문마다 `[CLS] <유형> question: <지시문> [SEP] [MASK] 선택지0 [MASK] 선택지1 … [SEP] state [SEP]`. 지시문+선택지는 head_max_len 256 토큰(선택지 1개 최대 48토큰, 넘치면 선택지를 균등 절단하고 지시문은 최소 8토큰까지 줄임), state는 나머지(최대 1024). 질문은 각각 별도 시퀀스로 한 번에 병렬 계산
- 결과(정답: 전문 agent / generalist / 새로 생성): S1 짧은 힌트 선택+없음+사소함 0.343(76ms, 200토큰) · S2 영어 설명 선택 0.378(105ms, 279토큰) · S3 후보별 예/아니오 13문항 0.192(362ms, 1364토큰) · S4 후보 설명을 state로 옮김(top3) 0.122 · S5 기술어 추출 추가 0.105 · S6 임베딩 유사도+신규 임계 0.163 · S7 후보별 3단계 선택 0.047. 새로 생성 판정 정확도는 최고 0.29, 예/아니오(noul)는 사실상 무작위
- 결론: 토큰 배치를 바꿔도 zero-shot 한계(범용 결정 데이터로 학습된 322M 모델, MASSIVE 20-way 한국어 0.45 수준)를 넘지 못함. 정확도를 올릴 방법은 **학습(증류)**: LLM judge 판정·사용자 수정·실행 결과를 정답으로 Laya 결정 헤드를 AI-PC GPU에서 미세조정, 카탈로그 일부를 가리는 증강으로 "맞는 전문가 없음"을 학습, held-out에서 judge와 같은 수준일 때만 사용

### F. 원격 PC 실행·디버깅·화면 (목표: 지정한 PC에서 실행·테스트·디버그하고 그 화면이 작업대와 모바일에 보인다)
- [~] F-01 러너 crate 골격: `pair`/`start`/`install-service`, 토큰 저장, WS 접속·heartbeat·재접속, capabilities 보고, allowed_roots. Linux·Windows cross-build 스크립트(`deploy/aidev/runner/build.sh`), macOS는 `ops/runner/build.sh`
  - 구현(2026-09-29): `deploy/aidev/runner/`(tokio, tokio-tungstenite rustls, ureq rustls, clap, toml). 명령 pair/start/status/caps/roots/consent/install-service/uninstall-service/unpair. 설정 `~/.aidev/runner.toml` 0600. WS Bearer + `runner.hello{capabilities}`(OS·arch·host·shell·도구 13종 버전·adb/sdb 기기·allowed_roots·screen 동의), 15s heartbeat·45s 무응답 재연결·지수 backoff+jitter, 401/403·close 4401 → exit 3. RPC `runner.ping`·`runner.capabilities`·`fs.resolve`. `roots.rs`: canonicalize + 미존재 경로는 가장 가까운 기존 상위로, 심볼릭 링크 탈출 거부. 서비스: systemd user unit / LaunchAgent / schtasks 로그온 작업(사용자 권한). 빌드 `build.sh`(zig로 linux-x64 glibc 2.28, 2.5MB) — 이 작업 환경은 static.rust-lang.org 차단으로 Windows·ARM·macOS std 설치 불가 → Mac `ops/runner/build.sh`(universal + zig 있으면 win-x64·linux-arm64). 검증: cargo test 6, `test/e2e.sh` 12항목(mock 게이트웨이: 잘못된 코드·원격 http 거부, 페어링, 0600, status 토큰 숨김, ping, 허용 폴더 밖 거부, 재연결, 4401·401 종료, capabilities). clippy 0
- [x] F-02 (서버 확인 9f95c7db: Mac m4pro 러너 0.2.2 online, 원격 대상 패널) 게이트웨이 `runner-hub.ts` + `/_runner/ws` + `targets` API(등록·pairing·정책·삭제) + 프런트 `TargetsPanel`(pairing 코드·온라인·capabilities) — 서버 검증: Mac 러너 접속, 목록에 online
  - 구현(2026-09-29): 게이트웨이 `runner-hub.ts` — `POST /_runner/pair`(코드가 자격, Origin 있으면 거부, IP당 10분 20회, 성공 시 32B 토큰의 SHA-256만 저장·코드 소거·기존 러너 4401 끊음), `WS /_runner/ws`(Bearer 해시 조회, Origin 있으면 거부, 대상당 1소켓·새 연결이 이전 대체, `runner.hello`로 capabilities·platform·allowed_roots 저장·online, 20s ping·45s 무응답 종료, JSON-RPC `call()`), 시작 시 전 대상 offline. API: `GET /targets`(online·connection·paired·capabilities·allowed_roots, 토큰 해시 제외), `POST /targets/:id/ping`(RTT), `/refresh-caps`, 삭제 시 러너 4401. 러너 바이너리 배포: `pack.sh`가 `runner/dist/*`를 릴리스 `control/runner/`에 넣고 게이트웨이가 `GET /_runner/download`(목록·sha256)·`/_runner/download/<file>` 제공(세션 불필요). 프런트 `src/modules/remote-target/TargetsPanel`(작업대 "원격 대상"): 등록(이름·설명·실행 정책 ask/auto/deny) → 페어링 코드 카드(대상 OS별 다운로드·pair·install-service 명령, sha256, 명령 복사, 새 코드), 5초 폴링 온라인 표시, 상세(도구·기기·허용 폴더·러너 버전·화면 동의), 연결 확인·정보 새로고침·다시 페어링·삭제(2단계). API는 `src/shared/api.ts`의 `api.targets`. 로컬: smoke +17(잘못된/1회용 코드, 브라우저 Origin 거부, 실제 러너 페어링·online·capabilities·ping 2ms·다른 사용자 차단·잘못된 토큰 401·재페어링/삭제 시 exit 3·옛 토큰 거부, 바이너리 목록·다운로드·경로 조작), UI e2e(등록→코드→러너 pair/start→연결됨→연결 확인 1ms→종료 후 오프라인). 서버 확인 대기: Mac 러너 접속(macOS 바이너리는 Mac에서 빌드)
- [x] F-03 (서버 확인 9f95c7db: verify가 Mac에서 exit 0·출력·PATH(node v22) 확인) `exec.start`(pty) 스트림 + `/targets/:id/stream` 멀티플렉스 + `RunOutputPane`; 모바일 실행 결과 카드
  - 구현(2026-09-29): 러너 0.2.0 `exec.rs` — `exec.start/write/resize/signal/list/tail` + `exec.exit` 알림, 출력은 바이너리 `[streamId][bytes]`. 사용자 셸(zsh -ilc/-lc, Windows cmd)로 실행, cwd는 allowed_roots 안, env는 기본값+작업 전달분(러너 env 비상속), pty(portable-pty)·파이프, 프로세스 그룹 신호, 제한 시간, 동시 16개, 스트림별 64KB tail, 연결이 끊겨도 계속 실행·러너 종료 시 모두 종료. 게이트웨이 `runner-hub.ts` — `exec()`가 stream id를 먼저 배정하고 `remote_runs` 기록 후 `exec.start{streamId, tag:"rr:<id>"}`, 출력은 스트림별 256KB ring + `/data/remote-logs/<id>.log`(≤20MB) + 대상 구독자, `exec.exit` → exit_code·artifacts(log·bytes·signal·duration). 재연결 시 `exec.list` 대조(끝난/유실 처리, 놓친 출력 `exec.tail`로 복구), **게이트웨이 재시작 전에 시작된 명령은 tag로 다시 붙임**. API: `POST /targets/:id/exec`(사용자 전용 — runtime 세션은 F-05 승인 경로로, policy deny면 403), `GET /targets/:id/runs`, `GET /remote-runs`, `GET /remote-runs/:id[/log?plain=1]`, `POST /remote-runs/:id/signal`; WS `/api/aidev/targets/:id/stream`(같은 origin·세션·소유 대상만; attach 시 ring 재생, write/resize/signal, started/exit/online/offline 이벤트). 프런트: 작업대 하단 탭·태블릿 창 "원격 실행" `RunOutputPane`(대상·작업 폴더·명령·대화형 토글, xterm 실시간·키 입력·크기 동기화, 중지/강제 종료, 실행 기록 → 지난 실행은 로그로), 모바일 설정 "원격 실행" `RemoteRunCard`(대상·명령·상태·exit·마지막 줄, 실행 중 2초 갱신·중지; F-05에서 채팅에도 사용). 로컬: cargo test 10, runner e2e 12, smoke +15(총 99: exit 3 기록·stdout+stderr 로그·허용 폴더 밖/잘못된 env/다른 사용자/정책 거부, 브라우저 스트림 pty 입력·resize·Ctrl+C·늦게 붙은 뷰어 재생, 다른 origin·남의 대상 소켓 거부, 게이트웨이 재시작 후 명령 인수·exit 5·출력 복구), UI e2e(작업대 `npm test` 성공(0)·pty 입력 "hi nado"·중지 SIGINT, 모바일 카드 2장). 서버 확인 대기: Mac 러너 0.2.0으로 실제 실행
- [x] F-04 (서버 확인 67097f3a: test 프로젝트 → m4pro `/Users/jazzlife/aidev-work/test` 3파일, 재동기화 올림 0·그대로 3 = diff 0) `sync.manifest/apply/delete`(blake3, ignore) + 런타임 `remote_sync` — 서버 검증: 프로젝트 1개 동기화 후 diff 0
  - 구현(2026-09-29): 러너 0.3.0 `sync.rs` — `sync.manifest{root}`(sha256, node_modules/.git/.aidev 제외, 심볼릭 링크 안 따라감, 5만 개), `sync.write{root, files[{path,b64,offset,last,mode}]}`(≤8MB/회, 큰 파일은 청크·`.aidev-part` 후 rename, 실행 권한 유지), `sync.delete{root,paths}`(`.aidev/sync-state.json`에 기록된, 동기화가 쓴 파일만 — 사용자 파일은 안 지움·빈 폴더 정리). root는 허용 폴더의 **하위** 폴더만, 경로는 상대·`..` 금지·심볼릭 링크 부모로 탈출 금지(생성 전에 검사). blake3 대신 sha256(런타임 Node 내장과 일치). 게이트웨이 `POST /targets/:id/rpc`(sync.*·fs.resolve·capabilities만, deny 정책이면 쓰기 거부, `~` 보정, 12MB 본문) + `/sync-report` → remote_runs kind=sync(올림·지움·그대로·바이트·시간). 러너 프레임 한도 16MB(큰 manifest). 런타임 `remote-sync.service.ts` + MCP `remote_sync{target?, project?, dest?, dryRun}`: 파일 목록 = git 저장소면 `git ls-files --cached --others --exclude-standard`, 아니면 .gitignore 걷기, 항상 .aidevignore + 기본 제외(node_modules·.git·.venv·.next 등), 파일당 50MB·전체 500MB·2만 개 한도, dest 기본 `<첫 허용 폴더>/<프로젝트명>`, 결과에 `dest`(remote_exec의 cwd)·의존성 설치 안내. MCP 프로세스 cwd = 세션 프로젝트 → 기본 소스. agent 지침: 원격 실행 전 remote_sync, 수정 후 재동기화. 작업대 "원격 실행"에 "프로젝트 동기화" 버튼(결과 표시·작업 폴더를 dest로). 로컬: 러너 테스트 12(동기화 왕복·탈출 거부 6종·심볼릭 링크), 런타임 remote-sync 3, smoke +8(총 125), **실제 Claude e2e**: "이 프로젝트를 my-mac으로 동기화하고 npm test" → remote_sync(3파일, node_modules 제외) → remote_exec npm test → exit 0 → run test_result=pass·outcome success; UI 재동기화 올림 0(diff 0) → 파일 수정 후 올림 1
- [x] F-05 (서버 확인 67097f3a: agent가 파일 작성 → remote_sync → m4pro에서 npm test pass 2 → 채팅 run #16 test_result=pass·outcome success) 런타임 MCP `remote_targets/exec/logs` + `remote.approve` Laya 게이트 + `ApprovalCard` + `remote_runs` 기록 — 서버 검증: agent가 "Mac에서 `npm test` 돌려" 수행, exit code가 run outcome에 반영
  - 구현(2026-09-29, F-04보다 먼저): 런타임 MCP `aidev-tools`에 `remote_exec{target?, cmd, cwd?, waitSec, background, timeoutSec, env}`·`remote_logs{remoteRunId, waitSec}`·`remote_stop` 추가(`remote_targets`는 agent용 요약). 턴마다 MCP env로 `AIDEV_RUN_ID`·`AIDEV_TARGET_ID`·`AIDEV_AGENT` 전달 → 원격 실행이 채팅 run에 묶임. 대상 생략 시 라우팅된 대상 → 온라인 1대. Claude는 `mcp__aidev-tools__*` 자동 허용(승인은 게이트가 담당), Codex는 `tool_timeout_sec 2700`. agent 지침에 "사용자 PC 실행은 remote_*로" 추가. 게이트웨이 `remote-gate.ts`: 위험도 = 규칙(파괴적 패턴 14종 → 2, 읽기·빌드·테스트 명령 → ≤0.5) + Laya `remote.approve`(결정 로그). 정책: deny → 거부, 파괴적 → 항상 확인, ask(기본) → 읽기·빌드·테스트만 바로 실행, auto → 위험도 ≥1.5만 확인. 승인 대기 10분(웹 푸시), 런타임은 `/approvals/:id/wait` 25초 long-poll, 결과는 `/remote-runs/:id/wait`(plain 출력 tail) long-poll. agent는 승인 불가(403). 거부·만료도 remote_runs 행(approved_by denied/expired). 원격 테스트 명령 종료 → 채팅 run `test_result` pass/fail → outcome 규칙에 반영. 프런트: 작업대 채팅 위 `RemoteApprovalCards`(명령·폴더·위험 사유·남은 시간, 허용/거부/허용+이 PC 자동 실행, 허용 후 "출력 보기" → 원격 실행 패널이 그 실행을 엶), 모바일 전 화면 `ApprovalSheet`(큰 버튼, 허용 후 결과 카드). 정책 이름 변경: ask "변경 명령은 확인", auto "위험 명령만 확인". 로컬: 규칙 단위 25종, 런타임 remote-exec 4종, smoke +17(총 115: 테스트 명령 자동 실행·결과 대기·run test_result=pass, rm -rf 승인 대기·agent 자기 승인 403·다른 사용자 안 보임·허용 후 실행 approved_by=user, sudo 거부 기록, 허용+자동 전환, auto에서 파괴적은 여전히 확인, deny 거부), **실제 Claude e2e**: "my-mac에서 npm test" → remote_exec 자동 실행·"7개 통과" 답변·run test_result=pass·outcome success / "build-tmp를 rm -rf로 삭제" → agent가 ls로 확인 → 승인 카드(작업대·모바일 동시) → 허용 → 삭제·ls 재확인. 서버 확인 대기: Mac 러너로 같은 흐름
  - 서버 검증(2026-09-29, 9f95c7db, 브라우저에서 실제 채팅): "m4pro에서 sw_vers·node -v" → remote_exec 자동 실행 7초·macOS 15.7.7/node v22.13.0 답변 / 파일 쓰기(정책 auto라 자동) / `rm -f hello.txt` → 승인 카드 → 허용 → approved_by=user 실행·ls 확인 / `sleep 150` → 101초 무출력 조기 반환 메시지. 발견·수정: 러너 0.2.1의 `~` 미해석·대화형 zsh(stdin 열림) 무한 대기(기록: echo hi 95분 0B) → 0.2.2 + 게이트웨이 경로 보정·30분 기본 제한·90초 무출력 알림·실행 로그; 좁은(<768px) 작업대 레이아웃에 승인 카드 누락 → 추가. 남은 확인: 원격 `npm test` 결과가 run outcome에 반영되는 것(로컬에서는 확인). 관찰: 단순 명령이 ai-integration·D3·opus로 라우팅됨(과잉 등급) → 라우팅 개선 과제
- [~] F-06 미리보기 터널 `/p/:target/:port/*`(HTML base 삽입·Location 재작성·WS HMR) + `remote_preview` + `PreviewPane`(기기 폭 프리셋) — 서버 검증: Vite dev 서버가 작업대 안에 표시, HMR 동작
  - 구현(2026-09-29): 러너 0.4.0 `tunnel.rs` — `tunnel.open{streamId,port}`(127.0.0.1 → ::1 순서로만 연결, 포트 1024~65535, 동시 64), 양방향 바이너리 프레임 `[streamId][bytes]`, `tunnel.closed` 알림, 연결 끊기면 전부 닫음, capabilities `features`에 `tunnel`. 게이트웨이 `runner-hub` `openTunnel()`(Duplex, http.request createConnection 호환) + `preview.ts`: `/p/<targetId>-<port>-<HMAC 16자>/…`(키 = 게이트웨이 비밀 + 사용자·대상·포트·러너 토큰 해시 → 다시 페어링/삭제 시 무효, 주소 자체가 자격이라 휴대폰에서도 열림). 격리: 모든 응답에 `CSP: sandbox`(allow-same-origin 없음) → 불투명 origin이라 플랫폼 localStorage 토큰·세션 쿠키 접근 불가, 브라우저 cookie/authorization은 개발 서버로 전달하지 않음, Host=localhost:포트·Origin 재작성(Vite allowedHosts·HMR 검사 통과), CORS *, Referrer-Policy no-referrer. 경로: 첫 요청에 모드 판별(keep = base가 `/p/<cap>/`로 설정된 서버, strip = 루트 서버), strip이면 HTML의 절대 src/href/action 재작성 + fetch/XHR/WebSocket/EventSource 접두 shim, 불투명 origin용 메모리 storage shim, Location·Set-Cookie Path 재작성, WS 업그레이드는 터널로 원문 전달. API `POST /targets/:id/preview{port,label}`(probe·base·hint), `GET /previews`, `DELETE /targets/:id/preview/:port`. 런타임 MCP `remote_preview{port,target?,label?}` + agent 지침(먼저 base 받기 → `--base`로 실행 → 다시 호출). 작업대 `PreviewPane`(하단 탭/태블릿 창 "미리보기", 목록·대상·포트 열기, 폭 390/820/전체, 새로고침, 새 창), agent가 연 미리보기는 자동으로 앞에 표시. 검증(로컬): cargo test 13, smoke +21(총 164: strip/keep 모드, 경로 재작성·shim, sandbox·CORS 헤더, 쿠키·인증 헤더 미전달, 모듈·리다이렉트·쿠키 경로·POST 본문, HMR 소켓 양쪽 모드·Origin 재작성, 위조·다른 포트 캡 거부, 다른 사용자 차단, agent 열기, deny 정책, 서버 중지 시 502), runtime 테스트 +1. 서버 실사용 확인은 Mac 러너 0.4.0 설치 후(최종 테스트)
- [~] F-07 화면 스트림 `screen.list/start/shot`(xcap → JPEG, 변화 감지, ≤10fps) + `ScreenPane` + `remote_screenshot`(agent가 화면 보고 판단) + 모바일 스냅샷 카드 — 서버 검증: 실행 중 데스크탑 앱 창이 작업대에 보임, 대역폭 측정 기록
  - 구현(2026-09-30): 러너 0.5.0 `screen.rs` — `screen.list/shot/start/stop`, 소유자 동의(`consent screen on`) 없으면 전부 거부, 캡처는 OS 도구(macOS `screencapture -x -D`, Windows PowerShell System.Drawing, Linux grim/gnome-screenshot/import/scrot) → 러너 안에서 축소(≤maxWidth, 기본 1440)·JPEG 재인코딩(image crate), 스트림은 화면이 바뀔 때만 프레임 전송(해시 비교), 최대 10fps(캡처가 느리면 그만큼 느리게), 연속 3회 실패 시 `screen.error` 후 종료, 연결 끊기면 정지. xcap 대신 OS 도구를 쓴 이유: macOS 전용 코드를 이 작업 환경에서 빌드·검사할 수 없고, Linux 빌드(zig, glibc 2.28)에 X11/Wayland/PipeWire 라이브러리 연결이 필요해짐. 게이트웨이: WS `/api/aidev/targets/:id/screen?display&fps&maxWidth`(세션·같은 origin·본인 대상) — 같은 설정의 시청자는 러너 스트림 하나를 공유, 마지막 프레임을 늦게 온 시청자에게 즉시, 느린 시청자는 프레임 건너뜀, 마지막 시청자가 나가고 8초 뒤 정지. REST `GET /targets/:id/screens`, `POST /targets/:id/screenshot`(JSON base64), `GET /targets/:id/screenshot.jpg`; 모든 캡처는 remote_runs에 kind=screenshot(누가·디스플레이·크기)으로 기록, 실행 금지 정책이면 agent 캡처 거부. 런타임 MCP `remote_screenshot`(MCP image 콘텐츠로 반환 → 모델이 화면을 봄) + agent 지침. 작업대 `ScreenPane`(하단 탭/태블릿 "화면": 대상·디스플레이·fps·해상도, 일시정지, 현재 화면 저장, 프레임·전송량 표시), 모바일 설정 "원격 PC 화면"(탭할 때마다 스냅샷, 다시 찍기). 검증(로컬): cargo test 14(동의·축소·변화 시에만 프레임·실패 알림), smoke +10(총 174: 동의 없음 거부, 디스플레이 목록, 320x180 JPEG, jpg 응답, 기록, 공유 스트림·늦은 시청자·변화 프레임, 다른 origin·다른 사용자 차단, agent 캡처, deny), runtime 테스트 +1, MCP image 응답 확인. 서버 실사용 확인은 Mac 러너 0.5.0 + 화면 기록 권한 허용 후(최종 테스트)
  - F-07b 원격 제어·고성능 스트리밍(2026-09-30, 사용자 요구 "단순 캡처가 아니라 원격제어처럼"): 러너 0.6.0 — 영상 모드(기본): ffmpeg로 실시간 인코딩(macOS avfoundation + VideoToolbox 하드웨어 H.264, Windows gdigrab + x264, Linux x11grab + x264; 기본 1440px·30fps·4Mbps, 2초 GOP, B프레임 없음, 키프레임마다 SPS/PPS) → `video.rs`가 Annex B를 액세스 단위로 자름(여러 슬라이스 한 장면 유지) / VP8(IVF)도 지원 → 프레임 `[kind][flags][data]`; ffmpeg 없거나 실패하면 이유를 알리고 JPEG로 자동 전환. `input.rs`(enigo: macOS CGEvent·Windows SendInput·Linux X11): 알림 `input.event`(move·button·wheel·key(+modifiers)·text)·`input.end`, 소유자 `consent control on` 없으면 무시, 전용 입력 스레드, 권한 오류는 `input.error`. 게이트웨이: 같은 설정 시청자 공유, 마지막 키프레임 이후 프레임(GOP) 보관해 늦은 시청자가 바로 디코딩, 느린 시청자는 다음 키프레임까지 건너뜀(지연 누적 없음), 제어는 `{op:"control"}` → 동의·정책 확인 → `input.event` 중계(초당 300 제한), 제어 세션마다 remote_runs kind=control(이벤트 수·시간). 프런트 공통 모듈 `remote-screen`(비시각): WebCodecs `VideoDecoder`(H.264 Annex B·VP8, 지연 우선, 밀리면 키프레임까지 건너뜀) → canvas, 없으면 JPEG; 입력 바인딩: 마우스 이동(프레임당 1회)·버튼·휠·우클릭, 터치(탭=클릭, 길게=우클릭, 드래그=드래그, 두 손가락=스크롤), 키보드(단축키·특수키는 key+modifier, 글자·IME·휴대폰 키보드는 text). 작업대 ScreenPane: 스트리밍/정지(정지 시 마지막 화면 + 새로 찍기), 화질(고화질·기본·60fps·저대역·이미지), 제어 토글(빨간 테두리·안내), 코덱·fps·Mbps 표시. 모바일 `/m/screen/:id`: 처음엔 정지(스냅샷), 스트리밍·제어 선택, 제어 시 키 막대(키보드·Ctrl/Alt/⌘/⇧ 고정·Esc·Tab·화살표·⌫·⏎). 검증(로컬): cargo test 18(AU 분할·IVF·키 매핑·동의·x264/VP8 실제 인코딩·실패 시 JPEG 전환), smoke 180 ALL PASS — Xvfb 실제 화면을 ffmpeg x11grab으로 H.264 스트림(SPS로 시작, ffmpeg로 45프레임 디코딩), 늦은 시청자 키프레임 시작, 동의 없으면 제어 거부, 제어 시 마우스가 X 화면에서 정확히 이동(xdotool), 제어 세션 기록, **실제 Chromium에서 WebCodecs가 스트림을 canvas에 그리고 canvas 클릭이 PC 포인터를 움직임**(이 Chromium은 H.264가 없어 VP8로 확인, 제품 경로는 같은 코드로 H.264). 서버 실사용: Mac 러너 0.6.0 + `brew install ffmpeg` + `consent control on` + 화면 기록·손쉬운 사용 권한 후(최종 테스트). 알려진 한계: 제어는 주 화면(1번)만, Windows 다중 모니터는 전체 데스크톱으로 캡처, 장면 1프레임(약 33ms) 지연(다음 장면 시작으로 끝을 판단)
  - F-07c 프로그램 창 단위 + 러너 단독 동작(2026-09-30, 사용자 요구 "데스크탑이 아니라 프로그램 창, 콘솔 앱이면 콘솔 창을 스트리밍 / 러너는 추가 설치 없이, 필요한 외부 앱은 내장"): 러너 0.7.0 — ffmpeg 의존 제거(`video.rs` 삭제). `appwin.rs`: 창 목록·캡처·앞으로 가져오기 — macOS/Windows는 xcap 0.9(CoreGraphics 창 이미지 / Win32 PrintWindow·DWM 경계, 가려진 창도 캡처), Linux는 x11rb로 직접(_NET_CLIENT_LIST 또는 최상위 트리, InputOnly·override-redirect 제외, 화면 밖으로 나간 부분은 검게 채워 GetImage BadMatch 회피); 활성화는 macOS osascript(System Events)·Windows Alt+AppActivate(pid)·X11 _NET_ACTIVE_WINDOW. `encoder.rs`: Cisco OpenH264를 소스에서 러너 바이너리에 정적 포함(ScreenContentRealTime, CBR, Baseline, 2초 키프레임, 크기 짝수 보정·축소), 창 크기가 바뀌면 인코더 재생성 + `screen.format`. 창이 바뀔 때만 인코딩(정지 화면 = 0 전송), `screen.key`로 키프레임 요청, 캡처 실패는 약 2초 연속일 때만 `screen.error`(= 스트림 종료) — 창 닫힘·최소화. `input.rs`: 이벤트에 `win`이 있으면 좌표를 그 창 경계(300ms 캐시)에 맞춰 변환, 제어 시작·다른 창이 포커스일 때 클릭하면 창을 앞으로, 키 입력도 그 창으로. Windows는 시작 시 Per-Monitor DPI aware(창 경계·캡처·입력 모두 물리 픽셀). 빌드: Linux는 zig로 glibc 2.28 + C++ 런타임 정적(libstdc++ 불필요, 3.8MB), x86은 nasm 필수(없으면 OpenH264가 SIMD 없이 빌드돼 3배 느림 → build.sh가 중단), Apple Silicon은 NEON(clang). `build.sh`의 zig 감지 버그 수정(`cargo zigbuild --version` 미지원 → 늘 호스트 링커로 빠지던 문제, pip `ziglang`도 인식). 게이트웨이: `window` 옵션(0.7 러너는 창 필수), 입력 이벤트의 `win`은 브라우저 값을 버리고 시청 중인 스트림의 창으로 덮어씀(0.7 러너에선 창 없이 제어 불가), 늦은/밀린 시청자는 `screen.key` 요청(500ms 제한), `screen.error`면 스트림 폐기(다음 시청자가 새로 시작), `GET /targets/:id/windows`(별칭 screens), 스크린샷 `{window|query}` + 기록에 창 이름. MCP `remote_windows` 추가, `remote_screenshot{window|query}`(없으면 포커스 창) + agent 지침. 프런트: `remote-screen`에 `useScreenSources`(창 + 러너로 실행 중인 콘솔, 선택이 사라지면 포커스 창으로 자동) · `RemoteConsole`(xterm은 처음 열 때 동적 로드 → 모바일 초기 번들 제외, pty면 키 입력·크기 조정, 모바일 키 막대 Esc/Tab/Ctrl-C/Ctrl-D/화살표/⏎). 작업대 ScreenPane·모바일 화면: 대상 → 프로그램(창 / 콘솔 / 0.7 미만은 디스플레이) 선택. 모바일 설정 "원격 PC 프로그램"(콘솔은 화면 동의 없이도). `check-bundle.mjs`가 지연 청크 파일명("xterm-….js")을 라이브러리로 오인하지 않게 수정. 검증(로컬): cargo test 19 + clippy 0, **smoke 184 ALL PASS**(배포 바이너리 그대로) — Xvfb 위 실제 프로그램 창(ImageMagick animate): 창 목록·경계, 이름으로 찾은 창 스크린샷·기록, 러너 내장 H.264(SPS로 시작, ffprobe 45프레임 디코딩, 640x360), 늦은 시청자 키프레임, 창 기준 좌표로 포인터 정확히 이동(브라우저가 보낸 다른 `win` 무시), 제어 기록에 창, 실제 Chromium canvas 클릭 → 창의 같은 지점, 프로그램 종료 → 스트림 종료 메시지·목록에서 사라짐; runtime 테스트 485/0(+1 remote_windows); 모바일 번들 초기 502KB. 인코딩 성능(이 2 vCPU 환경): 1080p 33.7ms/프레임(SIMD, nasm 없을 때 100ms) → 기본 1440px는 30fps 여유. 서버 실사용: Mac에서 러너 0.7.0 빌드 + `consent screen on`/`consent control on` + 화면 기록·손쉬운 사용 권한 + (활성화용) System Events 자동화 허용 — ffmpeg 불필요(최종 테스트). 알려진 한계: Windows·macOS 코드는 이 환경에서 컴파일 불가(static.rust-lang.org 차단) → Mac 빌드에서 확인; Linux는 X11(Wayland 세션은 XWayland 앱만); 가려진 X11 창은 compositor 없으면 가린 부분이 보일 수 있음; Windows 활성화는 포그라운드 잠금 때문에 Alt 키 입력 후 AppActivate(일반적 우회) — 그래도 실패하면 창 클릭이 위 창에 감(최종 테스트에서 확인)
  - F-06b 미리보기에서 개발 서버 찾기·시작(2026-09-30, 실사용 중 "포트 5173에서 실행 중인 서버가 없습니다" 반복 → 작업대에서 해결할 수단이 없던 문제): 러너 0.7.1 `devserver.rs` `dev.scan` — ① 이 PC에서 열린 TCP 포트(≥1024)와 프로그램: macOS `lsof -F pcn`, Linux `/proc/net/tcp{,6}` + fd 소켓 inode → pid·comm, Windows `netstat -ano` + `tasklist`(모두 OS 기본 도구, 설치 불필요), IPv4/IPv6 병합, 루프백·전체 바인딩만 미리보기 가능 표시 ② 허용 폴더 3단계 안의 package.json 프로젝트(dev/start/serve 스크립트, node_modules 등 제외, 최대 50): 프레임워크(vite·next·nuxt·sveltekit·astro·CRA·angular)와 패키지 매니저(pnpm·yarn·bun·npm 락파일)로 시작 명령 생성 — Vite만 `--base {base} --port {port} --strictPort`(keep 모드·HMR), 나머지는 포트만(루트 경로, strip 모드), CRA는 `PORT` env. 연결 거부 메시지에 "지금 열려 있는 포트: 3000 (node) …" 추가. 게이트웨이 `GET /targets/:id/dev?port=`(스캔 + 그 포트의 서명된 미리보기 경로; 0.7.1 미만은 연결된 버전을 알려 주는 업데이트 안내). 작업대 PreviewPane: 열린 포트 칩(클릭 = 열기, 포트 입력 자동완성), 프로젝트 선택 + 채워진 명령(편집 가능) + "개발 서버 시작" → 러너 pty 실행(원격 실행 탭에서 출력 보기) → 2초마다 확인해 그 포트 또는 시작 후 새로 열린 포트가 열리면 미리보기 열기, 실행이 끝나면 exit 코드와 함께 실패 표시, 2분 제한. 미리보기 경로는 포트마다 HMAC 서명이라 포트를 바꾸면 스캔을 다시 받아 채움. 검증(로컬): cargo test 24 + clippy 0(lsof·netstat·tasklist·/proc 파서, 실제 리스너 pid 확인, 프로젝트·명령 생성), smoke 191 ALL PASS(연결 거부 시 열린 포트 안내, dev 스캔, 작업대 흐름대로 명령 실행 → 포트 열림 → keep 모드 미리보기). Mac 러너는 0.7.1로 다시 빌드 필요(`./runner/build.sh mac`가 이제 설치·검증까지)
  - F-06c/F-07d 미리보기·원격 화면을 떠 있는 창으로 + 모바일·좁은 화면 제공(2026-09-30, 사용자 요구 "모바일·태블릿에 없음 / 팝업·오버레이로, 터미널 영역은 작아서 부적절"): `live-window` 모듈 — 작업대 위에 뜨는 창(제목 줄 끌어 이동, 모서리 크기 조절, 두 번 눌러 최대화, 최소화 → 오른쪽 아래 독, 닫기, "새 창으로 떼어 내기" = `/live/preview`·`/live/screen` 브라우저 창), 두 창 동시·앞으로 가져오기, 위치·크기는 뷰어별 localStorage(열림 상태는 저장 안 함), 브라우저 창이 줄면 제목 줄이 화면 안에 남게 보정, 최소화 중에는 내용이 멈춤(화면 스트림 중지). 데스크톱: 활동 막대에 "미리보기"·"원격 화면" 버튼, 하단 패널 탭에서 제거; 태블릿: 머리글 버튼(세그먼트에서 제거); agent가 연 미리보기는 창으로 자동 표시. 768px 미만 작업대(분할 화면·작은 창)도 태블릿 레이아웃(기존엔 원격 기능 없는 CloudCLI 탭 화면) + 창은 전체 화면만. `remote-preview` 모듈(비시각: 미리보기 목록·개발 서버 시작)을 분리해 모바일이 xterm 없이 사용. 모바일 앱: `/m/preview`(전체 화면 미리보기, 열린 미리보기 칩, + → PC·포트·열린 포트·프로젝트·"개발 서버 시작"), 대화 목록·채팅 상단의 "원격 PC" 메뉴(미리보기 + PC별 창·콘솔 화면), 채팅 중 agent가 미리보기를 열면 배너 "미리보기가 열렸습니다 · 보기". 검증(로컬): tsc, vitest 442(+4 창 상태), 두 앱 빌드(모바일 초기 353KB), Chromium에서 창 12항목(마우스 이동·크기·저장·최대화/복원·겹침 순서·최소화/독 복원·닫기·축소 시 보정·터치 이동·좁은 화면 전체) 통과. 수정: 빠른 터치에서 놓을 때 위치가 저장되지 않던 문제(렌더 전 pointerup) → ref로 보관
- [~] F-08 `target.select`·`remote.action` Laya 연결(라우터 대상 칩, 자동 선택·override 기록), `device.select`
  - 구현(2026-09-30): ① remote_action = Laya 확률 ⊕ 어휘 prior(NaiveBayes, `auth-gateway/data/remote-actions.jsonl` 183건 — none 68·run 30·test 25·debug 20·build 20·screenshot 20)를 로그 공간 융합(`LAYA_REMOTE_WEIGHT` 기본 0.35), 최고 확률 < `REMOTE_MIN_P`(0.5)면 none. Laya 장애 시 어휘 prior 단독. 라벨 원칙: 사용자 PC·기기(내 Mac/PC, 기기, 시뮬레이터/에뮬레이터, TV, adb/sdb, 네이티브 창, "화면 보여줘", PC 이름)를 가리킬 때만 none이 아님, 동사가 run/test/debug/build/screenshot을 가름, 코드 작업은 클라우드 런타임이므로 none. 보류셋 `laya/app/bench/remote-actions.jsonl` 93건(학습셋과 겹치지 않음) — 로컬 어휘 단독 0.882(min_p 0.5, 원격 recall 0.966, 오탐 0.118). ② 대상 규칙: 칩에서 직접 고른 PC(`input`) → 명령에 PC 이름(`mention`, 대시는 공백 허용·가장 긴 이름, 원격 작업이 none이면 가장 높은 비-none으로) → 채팅 고정(`session_settings.target_id`) → 계정 기본 PC(`targets.is_default`, 계정당 1개) → 온라인 1대(`single`) → Laya `target.select`(옵션: 설명·플랫폼·태그·도구·기기·화면 캡처, 최근 접속 순 — 낮은 확신이면 첫 번째) — 별도 decision으로 기록하고 `target_decision.decision_id` 반환. 고정 PC가 오프라인이면 다음 규칙으로 넘어가고 reason에 표시. ③ `device.select`: 대상에 adb/sdb 기기가 있고 명령이 기기 관련(기기·폰·TV·에뮬레이터·apk 등, "폰트"는 제외)일 때 — 시리얼이 명령에 있으면 그것, 1대면 그것, 여럿이면 Laya(기록) → `plan.device{serial,tool,source}` → 런타임 프롬프트에 "`adb -s <serial>`로 이 기기 지정". ④ API: `PUT /session-settings/:sid/target {target_id|null}`, `GET /session-settings/:sid`에 `target_id`, `PATCH /targets/:id {default}`, route 응답에 `targets`(온라인 PC 목록)·`plan.target.source`·`plan.device`·`device_decision`·`scope.remote_action_probability`; `/route/eval`은 `remote`(laya_only·lexical_only·fused·ko·가중치×임계값 28칸 sweep·best)를 응답 맨 앞에(`AIDEV_REMOTE_BENCH_FILE`, `{"remote":false}`로 생략). ⑤ UI: 작업대 라우터 바에 PC 칩(이름·선택 경위·기기, 드롭다운: 자동/PC별 선택·☆ 기본 PC), 모바일 라우터 시트에 같은 선택. 선택 = 채팅 고정(새 채팅은 id가 생길 때 고정으로 옮김) + route·target.select decision에 `final_target` 기록, 다음 명령부터 적용. 원격 대상 패널에 "기본 PC" 체크·배지.
  - 테스트: `auth-gateway/test/target-routing-test.mjs`(규칙 전부·기기 3경우·Laya 장애), smoke F-08 10건(총 202 PASS), runtime `sanitizeAidevOptions` device 검증·프롬프트, 클라이언트 `targetChipView` 4건. 서버 측정: verify의 `remote_action:` 줄(Laya vs 어휘 vs 융합) — 기준 fused ≥ 0.8·오탐 ≤ 0.15.
  - 서버 확인(e1b6535e, verify ALL PASS): 보류셋 93건 — 융합 **0.914**(원격 recall 0.983, 오탐 0.118) / Laya 단독 0.71(오탐 0.353) / 어휘 단독 0.882 / 한국어 0.896. α=0.35·min_p=0.5가 sweep 최고치와 같아 기본값 유지. 남은 확인(최종 실사용): 라우터 PC 칩으로 고정·기본 PC 지정, PC 2대 이상일 때 target.select, 기기 연결 PC에서 device.select.
- [~] F-09 `dap.start` 프록시(js-debug, debugpy, codelldb) + `DebugPane`(브레이크포인트 gutter ↔ code-editor, 콜스택·변수·콘솔) + `remote_debug_*` MCP — 서버 검증: Node 앱 브레이크포인트 정지·변수 확인, agent가 `remote_debug_*`로 원인 찾는 로그
  - 구현(2026-09-30): 구조 — **게이트웨이가 DAP 클라이언트**, 러너는 어댑터를 띄우고 터널만 제공(작업대 창과 agent 도구가 같은 세션을 봄). ① 러너 0.8.0 `dap.rs`: `dap.start{adapter,cwd,program}` → 어댑터를 127.0.0.1:<빈 포트>의 DAP 서버로 실행(js-debug `node dapDebugServer.js`, debugpy `python3 -m debugpy.adapter --port`, codelldb `--port`), 준비 판정은 **포트 bind 시도**(연결 탐침은 debugpy·codelldb의 단일 클라이언트를 소모함 — 실측), `dap.stop/list`, 끝나면 `dap.exited{id,code,tail}`, 연결이 끊기면 어댑터·디버기 종료. 사용자 설치 불필요: js-debug 1.112.0(tar.gz)·codelldb 1.12.3(플랫폼별 vsix)은 GitHub 릴리스에서 한 번 내려받아 SHA-256 고정값 확인 후 `~/.aidev/adapters/`에 풀고(경로 이탈 차단), debugpy 1.8.22는 `pip install --target`으로 사용자 Python을 건드리지 않고 설치(`AIDEV_ADAPTER_MIRROR`로 로컬 폴더 대체 가능). Node·Python 디버깅은 그 PC의 node/python3가 필요. `cwd`·`program`은 허용 폴더 안으로 해석한 실제 경로를 돌려주고 launch에 그 경로를 씀. `fs.read{path}`(허용 폴더 안 텍스트 ≤2MB, 소스 보기). ② 게이트웨이 `dap-client.ts`(Content-Length 프레이밍·요청/응답·이벤트·역요청) + `debug-hub.ts`: 세션 = 어댑터 + launch 설정(어댑터별: pwa-node/internalConsole/skipFiles, python/justMyCode/redirectOutput, lldb/terminal console) → initialize → launch ∥ initialized → setBreakpoints·setExceptionBreakpoints(기본 필터)·configurationDone. js-debug의 `startDebugging` 역요청 → 같은 포트로 자식 연결을 열어 실제 세션으로 삼음. 상태(starting/running/paused/ended/failed)·중단 위치·출력(64KB)·중단점 검증 상태를 이벤트(seq)로 기록 → long-poll `events(after, wait)`·`waitForPause`. 멈췄을 때 스택(내부 프레임 표시)·맨 위 사용자 프레임의 지역 변수(멈춤마다 캐시), evaluate(codelldb는 'watch' 문맥 — 'repl'은 LLDB 명령), variables/scopes, continue/next/stepIn/stepOut/pause, stop(terminate → disconnect). 세션마다 remote_runs(kind debug, 종료 코드). API: `POST /targets/:id/debug`(사용자는 바로, agent는 게이트 — 실행 명령 문자열로 위험 평가, 승인 카드는 "원격 디버그 실행", 허용되면 `approval.debugSessionId`), `GET /debug`, `GET /debug/:id[?wait]`, `/events`, `/control`, `/breakpoints`, `/evaluate`, `/variables`, `/scopes`, `DELETE /debug/:id`, `GET /targets/:id/file`. 게이트는 `GateStarter`로 일반화. ③ 런타임 MCP `remote_debug_start/_step/_eval/_breakpoints/_stop`: 멈춘 곳(함수·파일·줄)·스택(프레임 id)·locals(ref로 펼침)·중단점 검증·출력 꼬리·다음 행동 힌트를 돌려줌; 전문가 프롬프트에 "오류 원인은 로그 추측 대신 디버거로" 추가. ④ 프런트: `remote-debug` 모듈(비시각: debugStore — 편집기 중단점(작업공간 경로, 보는 사람별 저장)·선택 세션·세션별 경로 매핑·멈춘 줄, pathMap — 작업공간 프로젝트 ↔ PC 폴더(remote_sync 기본 목적지 <첫 허용 폴더>/<프로젝트명>, agent 세션은 폴더 이름으로 추정), useDebugSession/useDebugSessions/useAgentDebugSessions). 편집기(CodeMirror) 줄 번호 왼쪽 중단점 gutter + 멈춘 줄 강조(`code-editor/utils/debugGutter.ts`). 작업대 떠 있는 창 "디버그"(`remote-target/DebugPane`: 세션 선택·계속/한 줄/안으로/밖으로/일시 정지/중지·F5/F10/F11/⇧F11, PC의 소스(줄 gutter로 중단점)·변수 트리·호출 스택(프레임 선택 시 그 프레임 변수)·중단점 목록·콘솔(출력 + 식 계산), 좁으면 위아래 배치, "새 디버그" 폼 — PC·프로그램·디버거 자동(확장자)·npm 스크립트/파이썬 모듈·인자·PC 폴더·먼저 프로젝트 복사·첫 줄 멈춤, 편집기 중단점 동반), 새 창 `/live/debug`. 실행 중 세션과 매핑된 프로젝트는 세션의 중단점이 기준(편집기에 반영), 편집기에서 바꾸면 세션으로 전송. agent가 세션을 시작하면 디버그 창이 앞으로. 모바일 `/m/debug`(세션 칩·큰 단계 버튼·코드(점 열로 중단점)·변수·스택·출력+식 계산·간단한 시작) + 원격 메뉴 "디버그" + 채팅 배너 "agent가 디버깅 중".
  - 테스트: 러너 `dap::tests`(허용 폴더 밖·없는 프로그램·모르는 어댑터 거부, fs.read, 세 어댑터 준비·initialize 응답 — 미러 사용), 게이트웨이 `test/debug-hub-test.mjs`(실제 js-debug·debugpy·codelldb로 중단점 정지 → locals a=0 → eval a+b → continue(b=1) → step → 중단점 해제 → 끝까지, 출력·종료 코드·remote run), smoke F-09 16건(러너 0.8.0 릴리스 빌드 경유: js-debug 정지·eval·step·events·소스 보기·권한·중단점·끝까지·remote run / agent: debugpy 승인 대기 → 허용 → 정지 → continue → 사용자가 중지 → 러너에 어댑터 없음; 총 218 PASS), 런타임 도구 2건, 클라이언트 pathMap·gutter·DebugPane 동기화 7건.
  - 서버 확인(24926b1e, verify ALL PASS): 작업대 디버그 창(떠 있는 창)·모바일 `/m/debug` 표시 확인, m4pro는 러너 0.7.1이라 "0.8.0 이상으로 교체" 안내가 뜸. 사용자 런타임은 열린 세션 때문에 재시작 보류(`restart --drain runtimes` deferred) — 재시작돼야 agent의 `remote_debug_*` 도구가 생김. 남은 확인(최종 실사용): Mac 러너 0.8.0 설치 후 Node 앱 중단점 정지·변수, agent가 remote_debug_*로 원인 찾기.
- [~] F-09b~e 모든 플랫폼 프로그램 원격 디버깅 보장(2026-10-01, 사용자 요구 "윈도우·리눅스·맥·안드로이드·아이폰·SBC에서 빌드해 구동 가능한 모든 프로그램을 원격 디버깅 — 안 되면 같은 계열 agent CLI로라도"). 3단 보장:
  - ① DAP 어댑터 14종(F-09b, 러너 0.9.0 `dap_adapters.rs`): js-debug·debugpy·codelldb + gdb(14+ 내장 DAP, `debugger`로 gdb-multiarch·arm-none-eabi-gdb)·lldb-dap(Xcode `xcrun`, Linux `lldb-dap-NN`)·netcoredbg(.NET 6+: WPF/WinForms on .NET·Avalonia·MAUI·ASP.NET)·delve·**jvm = 자체 어댑터 aidev-jdi**(JDK JDI만 사용, 러너에 jar 내장 — kotlin-debug-adapter는 VM 시작 시 중단점 설치 전에 실행되는 경쟁·`src/main/java` 구조 강제·configurationDone 무응답이라 교체: 소스 이름 필터 ClassPrepare로 어떤 폴더 구조·중첩/익명 클래스·람다·Kotlin 파일 클래스에도 중단점, 조건 중단점, step, 예외, 식 계산(필드·static·배열·연산·메서드 호출), setVariable, launch/attach)·dart/flutter(툴체인 `debug_adapter`)·probe-rs(MCU)·mono(Unity/Mono)·**clrdbg = 자체 어댑터 aidev-clrdbg**(.NET Framework 2.0~4.8, Windows: vscode-mono-debug DAP 앞단 + debugger-libs Mono.Debugging.Win32/CorApi(ICorDebug), `deploy/aidev/clrdbg/build.sh`로 net472 빌드 → 게이트웨이 `/_runner/adapters/`(manifest SHA-256) 배포, 대상 PE/CLR 헤더로 x86/x64 디버거 자동 선택)·custom(아무 DAP 서버). 내려받는 어댑터는 버전·SHA-256 고정, stdio 어댑터는 러너가 1-클라이언트 TCP로 중계. 어댑터별 특이점 처리: GDB 먼저 configure, netcoredbg `initialized` 선행, 연결 직후 정지(attach·SIGSTOP) 자동 계속, 오래된 stackTrace가 재개된 세션을 paused로 되돌리지 않음.
  - ② 디버거 콘솔(F-09c, `console-hub.ts` + `remote_console_start/_send/_read/_stop`): 어댑터가 없는 모든 경우 — gdb·lldb·cdb+SOS(.NET Framework)·jdb·pdb·dlv·node inspect·adb shell·openocd 등을 PC의 pty에서 agent가 한 줄씩 조작. 프롬프트 인식((gdb) (lldb) (Pdb) 0:000> main[1] > >>> $ # y/n 확인 등, 사용자 정규식)·조용함 판정·ANSI/CR 정리·Ctrl-C·전사 256KB. 셸 탈출(shell/!/system())은 읽기 명령만 — 나머지는 remote_exec(승인)로. 사용자는 원격 실행 창에서 같은 콘솔을 보고 입력 가능.
  - ③ 로컬 agent CLI 위임(F-09d, `remote_agent`/`remote_agent_result`, `local-agent.ts`): 그 PC에 설치된 Claude Code·Codex·Gemini CLI에 작업을 맡김(그 PC의 IDE·SDK·시뮬레이터·기기·GUI 디버거가 필요할 때). 작업은 stdin으로 전달(러너 0.9.0 `exec.start{stdin}` — 어떤 OS에서도 셸 인용 없음), JSON 이벤트를 결과·단계·세션 id(resume)로 파싱. 전체 권한 위임은 항상 사용자 승인(게이트 규칙), 승인 카드에 맡길 작업 표시. 러너 capabilities가 claude/codex/gemini/gdb/lldb 버전을 보고.
  - 기기 브리지(F-09e, 러너 `devices.rs`): Android(adb `set-debug-app -w` → 시작 → pidof → `forward tcp:N jdwp:PID`, 세션 끝나면 원복) + jvm, iOS 시뮬레이터(`simctl launch --wait-for-debugger` → pid) + lldb-dap/codelldb, GDB 서버(`server`: gdbserver·OpenOCD·pyOCD·J-Link·st-util·QEMU `{port}`)로 SBC·MCU·에뮬레이터, 러너 armv7 빌드 대상(32비트 라즈베리 파이). 실기 iPhone은 콘솔(lldb) 또는 ③.
  - 게이트 강화: stdin 내용도 명령과 함께 평가, `env <cmd>`·`find -delete/-exec`는 안전 명령 아님, 다른 agent CLI 전체 권한 위임은 파괴적 작업으로 분류(항상 확인).
  - 테스트: 실제 러너 e2e `test/debug-e2e-test.mjs` 13건 PASS(gdb·custom gdb·netcoredbg C#·delve Go·jvm 2종·gdb+gdbserver·lldb-dap·iOS 시뮬레이터 브리지·Android 브리지(대역 adb/xcrun + 실제 JDWP/정지 프로세스)·js-debug attach·mono), aidev-jdi 프로토콜 테스트 3건(`runner/assets/aidev-jdi/test-dap.mjs`), 콘솔 e2e `test/console-e2e-test.mjs`(gdb·lldb·jdb·pdb·python REPL), agent 위임 실측 `test/agent-e2e-test.mjs`(러너 → `claude -p`가 버그를 컴파일·실행으로 확인·수정·재검증, 3턴), 러너 cargo 33건(stdin, PE 비트 판별, probe-rs initialize 포함), smoke 220 PASS(어댑터 manifest·해시·경로 이탈 포함), 런타임 12건(local-agent 파서: 실제 Claude stream-json 픽스처·Codex·Gemini).
  - 남은 확인: Windows 실기(aidev-clrdbg 실행, netcoredbg win64, 러너 Windows에서 agent CLI .cmd 실행), Mac에서 `ops/runner/build-netcoredbg.sh`(Apple Silicon netcoredbg), 실제 Android 기기·iOS 시뮬레이터, dart/flutter.
- [~] F-13 OS별 러너 빌드·설치 스크립트(2026-10-01, 사용자 지적 "각 OS별 빌드 스크립트가 없어" — 빌드·설치는 Mac(ops)용뿐이었음): `runner/scripts/` build-linux.sh(x64·ARM64·ARMv7 SBC, 도구 점검·패키지 관리자별 설치 명령·저메모리 모드)·build-macos.sh(universal, --cross)·build-windows.ps1(MSVC·NASM, `-InstallTools` winget) + install-linux.sh(systemd 사용자 서비스+linger, 없으면 백그라운드+cron)·install-macos.sh(LaunchAgent, ops/runner/install.sh가 호출)·install-windows.ps1(로그온 작업, 콘솔 창 없음). 설치 스크립트는 직접 빌드한 파일 또는 게이트웨이 다운로드(SHA-256 확인), `--code` 페어링, 같은 설정의 러너만 교체, 연결까지 확인. 게이트웨이 `/_runner/scripts/…`·`/_runner/source/aidev-runner-src.tar.gz`(바이너리 없는 OS·CPU는 그 PC에서 소스 빌드), 페어링 카드가 그 방법을 안내하고 ARM 보드 CPU를 고름. 러너 `start --hidden --log`, Windows에서 실행하는 모든 프로그램에 CREATE_NO_WINDOW. build.sh의 SHA256SUMS가 다시 빌드한 파일의 옛 줄을 남기던 버그 수정(설치 스크립트가 다운로드를 거부했을 것). 릴리스 바이너리: linux-x64·linux-arm64·linux-armv7·win-x64(ARM은 qemu로 실행 확인), clrdbg/build.ps1.
  - CI `runner-release.yml`(태그 `runner-v*`) 첫 실행(runner-v0.9.0, 84c30ab6): 11개 중 9개 성공, 2개 실패 → 수정. ① aidev-clrdbg: 러너 이미지의 .NET SDK 10(C# 14)에서 debugger-libs `MetadataType.cs`의 `field` 변수가 새 키워드가 됨(CS9273·CS1061) → `LangVersion latest`를 `12`로 고정(.NET 10 SDK로 재현·수정 확인). ② Windows ARM64: 소스는 aarch64-pc-windows-msvc로 컴파일·링크됨(클라우드 clang-cl/lld-link 교차 빌드 3분 23초, PE 0xAA64)을 확인 — build-windows.ps1이 x64 러너에서 ARM64 exe를 `--version`으로 실행해 실패 → 다른 CPU용 빌드는 PE 헤더로 확인, ARM64에 필요한 MSVC ARM64 도구·clang(ring)을 점검하고 PATH에 추가. netcoredbg(Apple Silicon)는 그 실행에서 성공(11분). 이제 모든 잡이 필수(하나라도 빠지면 게시 안 함), actions는 Node 24 버전(checkout v5·setup-dotnet v5·upload-artifact v6·download-artifact v7).
  - 테스트: smoke 230 PASS(스크립트·소스 제공, `curl|bash`로 install-linux.sh 실행 → 다운로드·페어링·상시 실행·온라인·--uninstall, install-windows.ps1을 irm으로 PowerShell 테스트 모드 실행 → 설치·페어링), 소스 tarball을 build-linux.sh로 빌드, 페어링 카드 2건. 운영(7f2bc536f794) 확인: 스크립트 7종 200, 바이너리 4종 SHA 일치, 운영 게이트웨이에서 install-linux.sh로 설치. 남은 확인: Windows·macOS 실기에서 스크립트 실행.
- [~] F-10 `device.list/shot`(adb/sdb) + `remote_device_*`; `device.mirror`(h264 → WebCodecs)는 2단계 표시
  - 구현(2026-10-01, 러너 0.10.0): `devices.rs` `device.list`(adb `devices -l`·sdb `devices`·macOS 부팅된 iOS 시뮬레이터 `simctl list devices booted -j` → `{tool, serial, state, name}`, 도구별 오류 따로) / `device.shot{tool?, serial?, maxWidth, quality}`(화면 동의 필요, serial 없으면 쓸 수 있는 1대 — 여러 대면 목록과 함께 거부, `unauthorized`는 USB 디버깅 허용 안내): adb `exec-out screencap -p`, 시뮬레이터 `simctl io <udid> screenshot`, sdb `enlightenment_info -dump_screen` → `sdb pull` → 러너 안에서 축소·JPEG. adb·sdb 경로 `AIDEV_ADB`/`AIDEV_SDB` → PATH → SDK 기본 폴더. capabilities `features`에 `device`. 게이트웨이 `GET /targets/:id/devices`, `POST /devices/shot`(+ `shot.jpg`), 캡처마다 remote run 기록(`device.shot adb <serial> — <이름>`), agent는 정책 deny면 거부. 런타임 MCP `remote_devices`·`remote_device_shot`(이미지 반환) + agent 지침. 작업대 원격 대상 패널에 기기 목록·"화면" 버튼(인라인 표시). 실시간 미러링(`device.mirror`)은 2단계.
  - 테스트: 러너 `devices::tests`(adb/sdb/simctl 출력 파싱, 동의·인자 거부), 실기 `real_device_shots`(ignored, 이 Mac: Android 에뮬레이터 1080x606 0.6초, iPhone 17 시뮬레이터 1080x2348 1.3초), smoke F-10 6건(대역 adb: 목록·unauthorized·320px JPEG·기록·agent·다른 사용자 거부; 총 201 PASS — 이 Mac에서), 런타임 도구 1건. 미검증: Tizen 실기/에뮬레이터(sdb 덤프 명령), 실제 USB 휴대폰.
- [ ] F-11 보안 점검: allowed_roots 우회 시도 거부, 토큰 폐기 즉시 끊김, 파괴적 명령(`rm -rf`) 승인 요청 발생, 화면 캡처 동의 없는 대상에서 `screen.*` 거부
- [ ] F-12 e2e(서버 로그·스크린샷): "이 React 앱을 내 Mac에서 실행해서 화면 보여줘" → route(remote_action=run, target=Mac) → sync → `npm run dev` → preview 패널 자동 표시(`ui.focus`) → "테스트 돌려" → exit code → outcome → 모바일에서 같은 세션 열면 결과 카드·스냅샷

**F 완료 기준**: F-12 e2e, F-11 점검 통과, 러너 3 OS 바이너리 존재(macOS는 Mac 빌드).

### D. 생성 (목표: 없는 분야를 스스로 만들어 검증하고 쓴다)
- [~] 확정(hint 필드 포함), 로컬 e2e에서 Claude가 3개 출처 지식과 함께 설계 블록 출력 — D-01 `agent-architect` 프롬프트·출력 스키마 확정(3.7), 시드에 포함
- [~] 구현(작업대·모바일 공용 useAgentCreation + AgentCreateCard), 로컬 e2e 확인 — D-02 프런트 watcher: `<aidev-agent>` 파싱 → `AgentCreateCard`
- [~] 승인→생성(knowledge sourced)→원래 명령 재전송(forceAgent)까지 로컬 e2e 확인(runtime 로그 agent=unity-shader-graphics, knowledge 950ch); 자가 검증은 카드의 버튼으로 선택 실행(verified 플래그), 실 Laya 판정은 서버 확인 대기 — D-03 승인 → `POST /agents`(knowledge sourced 포함) → 자가 검증 턴 → Laya `selfcheck.pass` → 활성화 → 원래 명령 자동 재전송
- [ ] D-04 D0~1 `create_queue` + 동일 분야 3회 반복 시 백그라운드 생성 제안(알림)
- [ ] D-05 Codex 전용 계정에서 생성 전 과정이 Codex로 동작
- [ ] D-06 서버 검증: 카탈로그에 없는 분야(예: "Unity 셰이더") 명령 → 생성 → 검증 → 실행 e2e

**D 완료 기준**: D-06 e2e 로그, 생성된 agent가 다음 명령에서 Laya에 의해 선택됨.

### E. 축적·학습 (목표: 실패가 줄고 지식이 최신으로 유지된다)
- [x] E-01 `runs.outcome` 결정 로직(3.8) + `outcome.classify` + `lesson-curator` 후보 생성 + `lesson.accept`
  - 로컬 검증(2026-09-23): 모바일 👎 → runtime `POST /api/aidev-tools/curate`(haiku, 도구 없음, ~40s) → `lesson.accept` 0.70 → 후보 → 카탈로그 승인 → 다음 라우팅에 주입. 새 세션 첫 명령의 run은 `complete` 시점에 `session_id`를 채운다(큐레이션에 필요). 게이트웨이 runtimeFetch 큐레이션 타임아웃 180s.
- [~] E-02 교훈 검증 게이트(자동 재성공 / 수동 승인), 3회 이상 → 프롬프트 승격(새 버전); `inject.select` 주입 선택
  - 구현(2026-09-28): 명령마다 실어 보낸 교훈을 `decision_lessons`에 기록 → run 결과로 학습(`lesson-loop.ts`). 후보는 Laya `lesson.relevant`(≥0.6, Laya 없으면 시험 없음)로 관련 있을 때만 명령당 1개 "[시험 적용]"; 성공 → verified(auto), 시험 중 2회 실패 → rejected; 검증 규칙이 실패가 성공보다 많고 3회 이상 → candidate 강등. 성공 3회 → 승격: agent·교훈 소유자가 같으면 프롬프트 "검증된 규칙" 섹션에 합쳐 새 버전(changelog), 공용 agent의 개인 교훈이면 "항상 적용"(top-k 밖). `hits`는 이제 주입 횟수가 아니라 성공 횟수. 카탈로그: 상태 라벨(시험 대기/자동 검증/항상 적용/프롬프트 vN)·성공/실패 수·수동 승격. 로컬: 시나리오 테스트 5종 + smoke +3, 실제 Claude 턴에서 시험 교훈 적용(aria-label·type=button) → 👍 → 자동 검증 확인. 서버 확인 대기
- [~] E-03 `escalate`·`handoff` 연결: fail → 다음 행동 자동 결정, 엔진 전환 시 요약 handoff 새 세션
  - 구현(2026-09-28): run이 처음 fail이 되면 게이트웨이 `escalation.ts`가 Laya `escalate`로 다음 행동을 고르고 규칙으로 실행 가능하게 보정 — 해당 엔진 로그인 끊김 → 다른 엔진(없으면 ask_user), 최상위 티어에서 escalate → 다른 엔진, 다른 엔진 없음 → 한 단계 위 티어, Laya 없음 → 한 단계 위 티어, 이어서 2번 실패(`escalated_from_run` 체인) → ask_user. 제안은 `runs.next_action`에 저장·outcome 응답의 `next`로 반환. 클라이언트는 한 번 누르는 카드(워크벤치 `EscalationCard`, 모바일 `EscalationPrompt`)로 제안 — 사용량을 쓰므로 자동 실행하지 않음. retry/escalate: 같은 명령을 제안 모델·effort·원래 agent로 1회 재전송(run에 `escalated_from_run`, 올린 depth 기록). switch_engine: runtime `POST /api/aidev-tools/handoff`가 대화 기록에서 인계문(원래·마지막 요청, 수정 파일, 실행 명령, 최근 오류, 마지막 응답 발췌, 지시)을 모델 호출 없이 만들고, 같은 프로젝트에 다른 엔진 세션을 만들어 인계문을 첫 턴으로 보냄. 새 명령을 보내면 카드는 사라짐. 부수: 교훈 큐레이터 Claude 호출은 `persistSession:false`(대화 목록에 "Analyze failed…" 세션이 생기지 않음), local-platform은 `CLAUDE_CODE_SESSION_ID` 상속 제거. 로컬: 단위 8종(escalation-test) + handoff 2종 + smoke +2, 워크벤치·모바일 e2e(실제 Claude 턴 → 👎 → D0→D1 재시도 run 기록 확인 / Claude→Codex 인계 새 세션·같은 agent·gpt-5.6-luna). 서버 확인 대기
- [~] E-04 `knowledge-refresher` 주기 작업(서버 cron: 주 1회) + `knowledge.stale` + superseded 처리
  - 구현(2026-09-28): 게이트웨이 `knowledge-refresh.ts`가 6시간마다 확인해 마지막 실행 후 7일(`AIDEV_KNOWLEDGE_REFRESH_DAYS`)이 지났으면 기한(90일)이 지난 출처 지식을 소유자별 최대 10건(`AIDEV_KNOWLEDGE_BATCH`) 재확인(`AIDEV_KNOWLEDGE_REFRESH=off`로 끔). 확인은 소유자 런타임 `POST /api/aidev-tools/knowledge-check` — Claude(sonnet, WebSearch/WebFetch, 기록 없음) 또는 Codex(terra, live 웹 검색), knowledge-refresher 프롬프트 사용; 공용 지식은 첫 관리자 런타임. 결과 적용: current → 90일 연장, unreachable → 14일 뒤 재시도·3회 연속이면 unverified(주입 중단), changed → Laya `knowledge.stale` ≥0.7 새 항목+구항목 superseded, ≤0.3 유지, 그 사이·Laya 불가 → `proposed` 행(검토 대기, 대상 항목은 재확인 제외). 컬럼 `checked_at/check_fails/check_note/replaces`. API `POST|GET /knowledge/refresh`(백그라운드 작업+진행 조회), `GET /knowledge/proposals`, `POST /knowledge/:id/decide`. 변경·검토가 생기면 푸시(`/m/settings?review=knowledge`). UI: 작업대 카탈로그 상단 "지식 갱신"(기한 지난 지식 확인, 제안 교체/유지), agent 상세 지식 목록에 상태·확인일·다음 확인·항목별 재확인; 모바일 설정 "지식" 섹션+검토 시트. 부수: 지식 조회·검색·라우팅 주입을 소유자 범위로 제한(공용 agent에 붙은 다른 사용자의 개인 지식이 보이던 문제). 로컬: 시나리오 8종(knowledge-refresh-test) + 파서 2종 + smoke +5, 실제 Claude 웹 확인 e2e("React 18이 최신" 항목 → 40초 → changed, React 19.3 근거 제안 → 모바일에서 교체 → 새 항목 sourced, 구항목 superseded). 서버 확인 대기
- [~] E-05 `tier_policy` 집계 작업(일 1회) + route에 반영, 변경 로그
  - 구현(2026-09-28): 게이트웨이 `tier-policy.ts`가 매일(6시간마다 확인, `AIDEV_TIER_POLICY=off`로 끔) 최근 30일(`AIDEV_TIER_WINDOW_DAYS`) run을 agent 분야×깊이×엔진 칸으로 집계 — 그 칸의 **현재 등급으로 실제 실행된 run만** 셈(사용자 지정 모델·agent 고정 모델 제외), 칸이 바뀌면 그 시점부터 다시 셈. 성공률 <60%·5회↑ → 한 단계 상향, ≥90%·10회↑ → 한 단계 하향(표보다 최대 1단계 아래), 하향한 칸이 <75%·5회↑ → 복귀. 칸은 `tier_policy.level/model/effort`(route가 기존대로 override 적용), 변경은 `tier_policy_log`. 관리자: `GET /tier-policy`(칸·기록), `POST /tier-policy/run`(지금 집계), `PUT /tier-policy`(등급 지정·고정·초기화), `manage-users tier-policy [run]`(verify-b에 출력 추가), 카탈로그 "등급 정책·엔진 가중치(관리자)" 패널. 로컬: 시나리오 6종 + smoke +6(관리자 고정 → 라우팅이 D4 best/xhigh 적용 확인). 서버 확인 대기
- [~] E-06 `engine_weights` 학습(task_kind×engine 성공률·시간), 관리자 편집 API
  - 구현(2026-09-28): `engine-weights.ts`가 E-05와 같은 일일 패스에서 작업 종류×엔진 가중치 = 최근 30일 성공률을 사전값(시드 또는 관리자 값) 쪽으로 가상 10회 보정(`(성공 + 10·사전값)/(n + 10)`, 0.05~0.95), 두 엔진 성공률 차이 5%p 이내면 20% 이상 빠른 엔진 +0.05. 고정된 가중치는 통계만 갱신. 0.02 이상 바뀌면 `engine_weight_log`. `engine_weights`에 prior/pinned/success_n/fail_n/avg_ms/updated_at 추가. 관리자 API: 기존 `PUT /engines/weights`에 `pinned` + 값이 새 사전값이 됨, `GET /engines/weights`(통계·기록). 패널에 작업 종류별 두 엔진 가중치·성공 수·고정 토글. 로컬: 시나리오 4종(2회 실패 0.417 / 18·20 성공 0.767 / 속도 +0.05 / 고정·사전값). 서버 확인 대기
- [ ] E-07 Laya: `/export/decisions?kind=` → kind별 온도 보정 스크립트(서버 GPU) → `aidev_models`에 보정 파라미터 원자 교체 → 벤치마크 재측정
- [ ] E-08 Laya fine-tune 파이프라인(공식 노트북 기반, 서버 iGPU, ≥300건부터) → 가중치 원자 교체 → 벤치마크 비교
- [ ] E-09 서버 검증: 같은 실패를 2회 유도 → 2회째에 교훈이 주입되어 회피되는 것을 로그로 확인; fallback 비율(`decision_log.fallback`)이 5% 미만

**E 완료 기준**: E-09 확인, 벤치마크 보정 전후 비교표.

---

## 5. 매 릴리스 절차
1. 클라우드: 구현 → `npm run build`(작업대 `dist` + 모바일 `dist-mobile` + 서버)/`tsc`(+ 러너 변경 시 `cargo build --release` cross) 통과, 모바일 번들 예산 통과 → 커밋 → `bash deploy/aidev/release/pack.sh /mnt/user-data/outputs/rel`
2. `release-<sha>.tgz`를 Mac `ops/releases/`로 전달 (러너 바이너리는 `ops/runner/`로 별도)
3. 배포: 사용자가 `./relay.sh watch`를 켜 둔 동안에는 Claude가 `ops/outbox/<id>.job`(허용 목록: deploy·rollback·status·list·restart·diag·gpu·logs·verify)으로 직접 배포하고 `ops/inbox/job-<id>.log`로 결과를 확인한다(2026-09-29). 꺼져 있으면 사용자가 `./relay.sh deploy releases/release-<sha>.tgz`. 서버 스크립트(`ops/scripts/*.sh`)가 바뀐 경우에만 사용자가 `./relay.sh scripts`. `verify`는 비밀번호 없이 서버 안에서 10분 세션을 발급·폐기(`manage-users session/end-session`).
4. 검증: `./relay.sh status`, 필요 시 `./relay.sh run <cmd>`/`diag` 로그 회수 → 체크리스트 [x] + 릴리스 ID 기록
5. 문제 시 `./relay.sh rollback`
6. 도구 이미지가 바뀌는 경우에만 `laya-image.sh build` / `runtime-image.sh build` (drop-in payload로 별도 실행)
7. 러너 갱신: Mac `ops/runner/build.sh` → `aidev-runner update`(게이트웨이 `/_runner/release`에서 버전 확인, 자기 교체는 2단계)

---

## 6. 위험과 대응
| 위험 | 대응 |
|---|---|
| Laya zero-shot 정확도 낮음(문서상 baseline 근처) | **실측(2026-09-23, 릴리스 1ce81d6b): 126건 중 76 미스(agent 40%)**. 원인: Laya는 모든 선택지를 `head_max_len≈192` 토큰 안에 "name: 설명"으로 넣으므로 13개 선택지면 선택지당 ~12토큰 — 긴 한/영 설명은 앞 몇 단어만 보였음. 대응: agents.hint(4~7 영단어) 도입, bench `--experiments`로 A 긴설명 / B 짧은 힌트 / C +짧은 기준 / D 2단계(분야→agent) / E 임베딩 앙상블 비교 후 채택, 그래도 부족하면 영어 명령은 영어 체크포인트(`convaiinnovations/laya`, en 0.78 vs 0.66)로 라우팅, 결정 로그로 보정→fine-tune |
| Laya 결정 지점이 많아져 지연 누적 | 한 이벤트당 Laya 호출 ≤2, 배치 질문(한 `/decide`에 여러 question), UI kind는 비동기(결과 늦으면 무시), fallback 즉시 |
| 잘못된 교훈 축적 | 후보/검증 분리, `lesson.accept`, 자동 재성공 또는 승인 없이는 주입 금지, 거절 기록 |
| 프롬프트 비대화로 지연·비용 증가 | depth별 길이 상한, `inject.select` top-k, 지식은 SKILL.md로 필요 시 로드 |
| Codex `developer_instructions` 동작 차이 | B-10에서 실제 세션으로 확인, 미동작 시 AGENTS.md 주입 대안 |
| 세션 provider 고정 | 새 세션 시작 시 엔진 결정, handoff는 요약 전달로 |
| 사용자 컨테이너 재시작(서버 레인) | `--drain` 롤링, 세션은 볼륨 보존 |
| 관리자 승인 병목(전역 승격) | 개인 범위에서 먼저 효과, 승격은 주기 검토 |
| 작업대가 upstream 레이아웃과 충돌 | 본체는 분기 1곳, 패널은 기존 모듈을 props로 그대로 마운트, upstream 머지 시 `workbench/`만 재검토 |
| 두 앱 사이 기능 불일치·중복 구현 | 프로토콜·상태 머신은 `chat-core` 한 곳, 새 서버 이벤트는 코어에 먼저 추가; 화면은 앱별 책임(중복 허용). 릴리스마다 C-11 딥링크 교차 확인 |
| 모바일 번들이 다시 비대해짐 | 금지 import ESLint + 빌드 시 예산 검사(실패), 청크 크기를 릴리스 기록에 남김 |
| 미리보기 경로 재작성 실패(절대 경로 SPA) | `<base>` 삽입 + 안내(Vite `base` 설정), 실패 시 §7 서브도메인 방식으로 전환 |
| 화면 스트림 대역폭·CPU | 변화 감지 프레임 생략, ≤10fps, JPEG 품질 적응, 모바일은 스냅샷만; WebRTC는 측정 후 결정 |
| 러너 보안(사용자 PC에서 임의 실행) | outbound 전용, allowed_roots, `remote.approve`+policy, 전 실행 기록, 토큰 해시·즉시 폐기, 캡처 명시 동의 |
| macOS 러너 cross-build 불가 | Mac에서 빌드(`ops/runner/build.sh`), 릴리스에 체크섬 기록; Linux/Windows만 클라우드 빌드 |
| DAP 어댑터별 차이 | js-debug·debugpy·codelldb 3개만 1차 지원, 나머지는 `custom`(사용자 명령) |

---

## 7. 열린 결정 (기본값으로 진행 중, 바뀌면 여기와 §0 갱신)
- 교훈·지식 범위: 사용자별 축적, 전역 승격은 관리자 승인 → **기본값 채택**
- 계정 엔진 권한 관리: `aidev-user` CLI 옵션 → **기본값 채택**, 관리 UI는 C 이후 검토
- 분야별 엔진 선호 초기값: bulk_read=Codex 우세, 나머지 중립 → **채택**
- 생성 자가 검증의 판정: Laya `selfcheck.pass` + 도구 오류 0 → **채택**, 부족하면 LLM 검토 추가
- DB: SQLite 유지 → **채택** (전환 조건 §0)
- 미리보기 URL: 경로 방식 `/p/<target>/<port>/`로 시작 → **채택**. SPA 절대 경로 문제가 실제로 잦으면 서브도메인 `preview-<t>-<p>.nado.work`(와일드카드 인증서 `*.nado.work` 적용 가능, NPM에 host 자동 등록 필요 → 원칙 3 예외 승인 필요)
- 러너 언어: Rust → **채택**(사용자 선호, 단일 바이너리·저자원). macOS 빌드는 Mac에서.
- 동기화 방향: 런타임 → 원격 PC 단방향 + 결과물 회수 → **채택**. 원격 PC에서의 편집 반영(역방향)은 F 이후 별도 단계.
- 원격 화면: **원격 제어 포함**(2026-09-30 사용자 결정) — 고성능 영상 스트리밍 + 마우스·터치·키보드 제어, 스트리밍/정지는 사용자가 선택. 제어는 사람(작업대·앱)만, PC 소유자의 `consent control on` 필수, 세션마다 기록. agent는 보기(`remote_screenshot`)만.
- 디버그 1차 어댑터: js-debug, debugpy, codelldb → **채택**
- UI 분리: 반응형 단일 앱 대신 모바일·작업대 두 앱 → **채택**(성능·디자인 독립). 태블릿은 작업대 소속. 모바일 앱의 네이티브 래핑(Capacitor, 푸시·백그라운드)은 C 완료 후 검토
