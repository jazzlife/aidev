# 모바일 기능 동등화(C-12) 작업 지시서 — v1, 2026-10-04

> 콘솔(Claude Code)에서 이 문서대로 작업한다. 저장 위치: `docs/aidev/MOBILE-PARITY-PLAN.md`.
> 기준 커밋: `origin/main` = `f0b8006`. 이 문서의 사실(파일 경로·API·응답 형태)은 그 커밋에서 확인했다. 확인하지 못한 것은 **[구현 전 확인]**으로 표시했다.
> 작업 시작 전에 `docs/aidev/IMPLEMENTATION-PLAN.md` §C에 항목 `C-12`(아래 C-12.1~C-12.9)를 먼저 추가한다(계획서 규칙: "여기 없는 일을 하게 되면 먼저 이 문서를 고친다").

---

## 0. 목표와 원칙 (사용자 결정, 2026-10-04)

- 모바일은 작은 화면에서 **채팅으로 agent에게 명령하는 앱**이다. 빠지는 것은 **코드를 보거나 작성하는 UI(편집기·터미널·파일 트리)뿐**이고, **기능 제약은 두지 않는다.** 채팅·프로젝트의 기본 기능 중 "작업대에서만 가능"한 것을 최소화한다.
- 화면은 단순하게. 버튼은 사용성 기준으로 배치한다.

### 배치 규칙 (모든 화면 공통 — 새 기능은 반드시 이 표의 한 곳에 둔다)

| 종류 | 위치 | 예 |
|---|---|---|
| 지금 바로 쓰는 기능 | 그 화면에 직접 노출 | 입력창 한 줄: 첨부·권한 모드·중지·보내기. agent 질문/승인은 즉시 시트 |
| 대상(메시지·대화·프로젝트)에 딸린 동작 | **길게 누르기 또는 ⋯ → 대상별 시트 하나** (어느 화면에서 열어도 같은 시트) | 메시지: 복사·읽어 주기·수정 후 재전송·여기서 분기 / 대화: 이름 변경·분기·숨기기·삭제 / 프로젝트: 즐겨찾기·이름 변경·제거 |
| 화면 전체의 보조 기능 | 상단 바 오른쪽 아이콘 (🔍, ⋯) | 대화 목록 🔍 검색, 대화 화면 ⋯(대화 시트·내보내기·토큰·예약 목록) |
| 당장 안 써도 되는 기본값·환경 | 설정 화면만 | 저장된 허용 규칙, 음성 설정, 알림, 엔진 |
| 이동 | 홈 탭(프로젝트 · 대화), 드로어(현재 작업 + 원격 PC + 기타) | 드로어에는 목록을 두지 않는다 |

---

## 1. 작업 규칙

1. **모바일 코드 위치**: `src-mobile/` (화면 `screens/`, 컴포넌트 `components/`, 비시각 로직 `lib/`, 테스트 `tests/`). 별칭 `@m/*` = `src-mobile/*`, `@/*` = `src/*`.
2. **모바일이 `src/`에서 가져올 수 있는 것**: `@/modules/chat-core`, `@/modules/aidev-router`, `@/modules/remote-*`(비시각), `@/shared/*`. 작업대 모듈(`chat`, `sidebar`, `git-panel` …)을 직접 import 하지 않는다. 필요한 비시각 로직은 **`src/modules/chat-core/index.ts`에서 re-export**한다(이 배럴만 deep import 허용 — 파일 상단 주석 참고). re-export 대상이 React 렌더러·CodeMirror·mermaid 등을 끌고 오면 안 된다(아래 번들 검사로 확인).
3. `src/` 를 고칠 때는 `AGENTS.md` → `.agents/skills/frontend-module-standards/SKILL.md`를 따른다(서버는 `backend-module-standards`). 이번 작업은 서버 수정 없이 가능하다 — 서버를 고쳐야 하면 먼저 이 문서에 이유를 적는다.
4. **번들 예산**: 모바일 초기 청크 ≤600KB(현재 약 129KB). `npm run build:client:mobile`이 `scripts/check-bundle.mjs`로 검사한다(초기 청크에 `@codemirror`, `xterm`, `mermaid`, `katex`, `cytoscape`, `react-scan`, `monaco`가 있으면 실패). 계획서가 말한 ESLint `no-restricted-imports` 규칙은 **저장소에 없다** — 번들 검사가 유일한 방어선이다.
5. **검증 명령** (항목마다 끝에 실행, 결과를 보고에 적는다)
   ```bash
   npx tsc --noEmit -p tsconfig.json        # src + src-mobile 모두 포함
   npx vitest run src-mobile                # 모바일 테스트
   npm run build:client:mobile              # 빌드 + 번들 예산
   npm run test:client && npm run typecheck # src/ 를 고쳤을 때
   npm run lint                             # oxlint는 src/ server/ 만 검사(src-mobile 미포함)
   ```
6. **커밋**: Conventional Commits(`feat(mobile): …`), 본문에 무엇을·왜, 끝에 `Co-Authored-By: Claude …`. 항목(C-12.x) 하나 = 커밋 하나 이상. 끝나면 계획서 항목을 `[~]`(로컬 검증)로, 실기기 확인 후 `[x]`.
7. **사용자 문구**: 한국어, 짧게. 오류는 서버 메시지를 그대로 보여 주되 없으면 "실패했습니다 (상태코드)".

---

## 2. 단계 0 — 이전 작업 반영 (C-12.1~C-12.3)

채팅 환경에서 구현·검증한 커밋 2개가 번들로 전달됐다(`aidev-ckpt_mobile-parity-20261004.bundle`, 선행 커밋 `f0b8006`).

```bash
git fetch origin && git checkout main && git pull --ff-only origin main
git status                                   # 깨끗해야 함
git log -1 --format=%h                       # f0b8006 이어야 번들이 바로 붙음
git bundle verify <번들 경로>
git pull --ff-only <번들 경로> main           # → d00bb12, 4f9e00e
# 또는: git am 0001-*.patch 0002-*.patch
```
- `origin/main`이 `f0b8006`보다 앞서 있으면: 번들을 `git fetch <번들> main:mobile-parity` 로 받은 뒤 `git rebase origin/main mobile-parity` → 충돌 시 아래 명세를 기준으로 해결.
- 반영 후 §1-5 검증 전부 실행. 기대값: tsc 0 오류, `vitest run src-mobile` 43개 통과, 모바일 빌드 예산 통과.
- 번들이 없으면 C-12.1~C-12.3을 아래 명세대로 다시 구현한다(명세에 파일과 동작, 테스트가 모두 적혀 있다).
- 반영 후 `git push origin main`.

---

## 3. 완료된 작업 명세 (재구현·검토 기준)

### C-12.1 드로어·홈 탭·프로젝트 추가·화면 전환 로딩 — 커밋 `d00bb12`(앞부분)

**드로어** (`components/AppDrawer.tsx`)
- 제거: 대화 목록·새 대화·프로젝트 목록(8개)·모든 프로젝트.
- 추가: 섹션 "현재 작업" — 카드 2장.
  - 프로젝트 카드: 이름·경로, 탭 → `/projects/:id`. 없으면 점선 안내 "선택된 프로젝트가 없습니다 · 홈의 프로젝트 탭에서 고르거나 추가하세요".
  - 대화 카드: 제목, `api.runningSessions()`(`GET /api/providers/sessions/running` → `{data:{sessions:[{sessionId,…}]}}`)로 실행 중이면 라벨 "진행 중인 대화" + "응답 중" 점, 아니면 "최근 대화". 다른 프로젝트의 대화면 둘째 줄에 프로젝트 이름. 탭 → `/session/:id`. 다른 대화가 실행 중이면 "다른 대화 N개 실행 중 ›"(→ `/`).
- 원격 PC·기타 섹션은 그대로.

**현재 작업 저장소** (`lib/current.ts`, `useSyncExternalStore`)
- `project`: 키 `m.project`(기존 키 유지 — `ProjectPicker.readLastProject()`가 이걸 읽는다). 설정 시점: 프로젝트 화면 열 때, 대화 열 때(그 대화의 프로젝트), 프로젝트 선택 시트, 프로젝트 추가 직후. → **드로어의 프로젝트 = 새 대화가 시작될 프로젝트**.
- `conversation`: 키 `m.conversation`. ChatScreen이 `meta`를 알 때마다 설정. 숨기기·삭제 시 `forgetConversation()`.

**홈 탭** (`components/HomeTabs.tsx`): 순서 "프로젝트 · 대화". 루트 `/`는 대화 목록 그대로(딥링크·뒤로가기·배지 유지).

**프로젝트 추가** (`components/AddProjectSheet.tsx`, 프로젝트 탭 + FAB)
- 탭 "폴더": `api.browseFilesystem(path|null)` → `{path, suggestions:[{name,path}]}` 폴더 목록(↑ 상위, 탭하면 진입, 새 폴더 = `api.createFolder(path)`), 경로 직접 입력 가능, 표시 이름(선택). 추가 = `api.createProject({path, customName?})` → `{success, project}`. 서버가 없는 폴더를 만든다(`ensureWorkspaceDirectory`). 보관된 경로를 재사용하면 서버가 보관 상태로 두므로 `project.isArchived`면 `api.restoreProject(id)`.
- 탭 "Git 복제": 저장소 주소 + 복제할 위치(같은 폴더 목록) → `new EventSource(api.cloneProjectProgressUrl({path, githubUrl, githubTokenId, newGithubToken:null}))`, 이벤트 `progress|complete|error`, `complete.project`. 대상 경로 미리보기 `→ 위치/저장소명`(서버 규칙: URL 끝 `.git`·`/` 제거 후 마지막 조각). 저장된 토큰 `api.settings.credentials('github_token')` → `{credentials:[{id,credential_name,is_active}]}` 중 active. **새 토큰 입력은 넣지 않음**(SSE URL 쿼리에 실림). 시트를 닫으면 EventSource 종료 = 서버 복제 취소.
- 성공 → 현재 프로젝트로 설정하고 그 프로젝트 화면으로 이동. 409(이미 있음) 등은 시트 안 오류로.

**화면 전환 로딩** (원인: `App.tsx`에서 lazy 화면의 Suspense fallback이 부팅 `<Splash/>` → 처음 여는 화면마다 앱 로딩과 같은 전체 화면)
- `BrowserRouter future={{ v7_startTransition: true }}`(react-router-dom 6.30.1) — 모든 이동이 transition → 이미 보이는 화면은 다음 화면 준비까지 유지.
- 보호 라우트를 **레이아웃 라우트 하나**로: `<Route element={<Gate/>}>` + `<Outlet/>`. Suspense·WS·드로어가 이동 사이에 유지된다(새로 마운트되는 Suspense는 transition 중에도 fallback을 보이므로 필수).
- `lib/lazyScreen.ts`: `lazyScreen(load)` = `React.lazy` + `preload()`. **렌더가 기다리는 다운로드만** 카운트(유휴 프리페치는 제외). `components/RouteProgress.tsx`: 상단 2px 막대, 표시 지연 120ms는 **CSS `transition-delay`**(setTimeout+state는 jsdom/transition에서 커밋되지 않는 문제가 있었다).
- 로그인 후 유휴 시 프리페치: Chat → Projects → Project → Settings 순, `saveData`·2g면 건너뜀.
- Splash는 세션 복원과 콜드 스타트 딥링크의 첫 다운로드에만.
- 목록 3곳(대화·프로젝트·프로젝트 안 대화) "불러오는 중…" → `components/Skeleton.tsx` `ListSkeleton`. 청크 실패 시 `ScreenErrorBoundary`("다시 시도" = reload).

테스트: `tests/screens.test.tsx`(드로어 현재 작업·실행 중 표시, 탭 순서, 프로젝트 추가 성공/409), `tests/route-progress.test.tsx`(transition 중 스플래시 없음·막대 켜짐, 프리페치는 막대 안 켬).

### C-12.2 채팅 기본 기능 (작업이 막히던 것) — 커밋 `d00bb12`(뒷부분)

| 문제(이전) | 해결 | 파일 |
|---|---|---|
| AskUserQuestion에 허용/거부만 보내 **답이 비어 전달** | 질문 시트: 선택지 탭(단일/다중), 직접 입력, 여러 질문 단계, 건너뛰기. 전송 `{allow:true, updatedInput:{...input, answers:{[question]: "a, b"}}}` (작업대 `AskUserQuestionPanel`과 같은 형식). Codex `request_user_input`도 서버가 `AskUserQuestion`으로 통일(`server/shared/message-unification.ts`) | `components/PermissionSheet.tsx` |
| "항상 허용" 없음 | 거부 · 허용 · **항상 허용 `<규칙>`**(Claude). 규칙 = `buildClaudeToolPermissionEntry`(Bash는 `Bash(npm:*)`, `Bash(git commit:*)`), `grantClaudeToolPermission`으로 **서버 동기화 설정 `claudePermissions`**에 저장(작업대와 공유), 같은 규칙의 대기 요청도 함께 허용, 응답에 `rememberEntry` 포함 | `PermissionSheet.tsx`, `screens/ChatScreen.tsx` |
| 계획 승인이 JSON | `ExitPlanMode`는 계획 본문 텍스트 + "계속 계획"/"승인하고 실행" | `PermissionSheet.tsx` |
| 권한 모드 `default` 고정, **저장된 허용 규칙을 안 보냄** | 입력창 알약 → `PermissionModeSheet`. 모드 목록은 `api.providers.capabilities()`(`data.providers[].permissionModes/defaultPermissionMode`, fallback 작업대와 동일). **대화별** 저장(`m.permissionMode.<sessionId>`, 새 대화 초안 `…new` → 생성 시 이전). 송신 옵션 = `{permissionMode, toolsSettings:{allowedTools,disallowedTools,skipPermissions}, skipPermissions}`(작업대 `buildSendOptions`와 동일, 모델·effort는 라우터) | `lib/chatOptions.ts`, `components/PermissionModeSheet.tsx`, `ChatScreen.tsx` |
| 응답 중 입력 불가 | 보내기 유지 → "대기 중" 카드(수정·취소), 응답 끝(그리고 대기 중인 승인 없음)에 자동 전송. 중지 버튼은 옆에 | `components/Composer.tsx`, `ChatScreen.tsx` |
| 첨부 없음 | 📎 → `<input type=file multiple>`(휴대폰이 카메라·사진·파일 선택 제공), 10개·10MB(서버 한도), `api.assets.uploadFiles(FormData 'files')` → `{attachments}` → 송신 `options.attachments`. 보낸 메시지에 이미지(`images[].data` 또는 `api.assets.image(파일명)` blob)·파일 이름 | `Composer.tsx`, `lib/chatOptions.ts`, `components/MessageBubble.tsx` |
| 긴 대화는 최신 페이지만 | 위로 스크롤(160px) 또는 "이전 메시지 보기" → `sessionStore.fetchMore(sessionId)`, 보던 위치 유지(아래로부터 거리 보존) | `components/MessageList.tsx` |

chat-core re-export 추가: `buildClaudeToolPermissionEntry`, `grantClaudeToolPermission`, `getClaudeSettings`, `readUserPreference`, `subscribeToUserPreferences`, 타입 `PermissionMode`, `Question`.
테스트: `tests/chatParity.test.tsx`(질문 답·다중·직접 입력, 항상 허용 규칙, 계획 승인, 응답 중 대기열·중지, 첨부·모드 알약, 이전 메시지).

### C-12.3 대상별 시트·대화 검색 — 커밋 `4f9e00e`

- `components/ConversationActions.tsx` — 대화 시트(대화 목록 길게/⋯, 프로젝트 안 목록 길게/⋯, 대화 화면 ⋯): 이름 변경 `api.renameSession(id, summary)`, 분기 `api.forkSession(id)` → `data.sessionId`로 이동(엔진 `supportsSessionForking`일 때만), 숨기기 `deleteSession(id,false)`/다시 표시 `restoreSession`, 삭제 `deleteSession(id,true)`(확인 단계). 현재 대화면 드로어 제목도 갱신.
- `components/ProjectActions.tsx` — 프로젝트 시트(프로젝트 목록 길게/⋯, 프로젝트 화면 ⋯): 즐겨찾기 `toggleProjectStar`, 이름 변경 `renameProject(id, name)`(비우면 폴더 이름), 제거 2가지 — 목록에서 제거 `deleteProject(id,false)`(보관, 같은 폴더 다시 추가 시 복귀) / 대화 기록까지 삭제 `deleteProject(id,true)`. **어느 쪽도 폴더는 지우지 않음**(서버 `force=true` = DB 행·세션 행·Claude jsonl만).
- 메시지 시트(`ChatScreen.tsx`, 메시지 길게): 복사, 읽어 주기(assistant, `voicePlayer` — chat-core re-export), **수정 후 다시 보내기**(user 턴에 `transcriptAnchorId`가 있고 엔진 `supportsMessageEditing`, 응답 중 아님 → 입력창에 내용 + "수정 중" 막대 → `{type:'chat.edit-send', anchorId}` + 에코 `replacesAnchorId`; 서버가 잘라낸 뒤 실시간 핸들러가 `truncateAt`), **여기서 분기** `forkSession(id, {upToAnchorId})`.
- `components/ConversationSearch.tsx` — 대화 목록 🔍: `new EventSource(api.searchConversationsUrl(q, 50))`, 이벤트 `title-results{titleResults}` · `result{projectResult:{projectDisplayName, sessions:[{sessionId,sessionSummary,provider,matches[{snippet}]}]}}` · `done`, 300ms 디바운스, 2자 이상, 제목 결과 우선·중복 제거.
- `lib/chatOptions.ts`에 `useCapsMap()`(목록에서 엔진별 지원 여부).
테스트: `tests/actionsParity.test.tsx`(이름 변경·드로어 반영, 분기·삭제 확인, 분기 미지원, 프로젝트 즐겨찾기·보관·현재 프로젝트 해제, 검색 결과·이동).

### 검토에서 나온 후속 수정 (C-12.4 — 먼저 처리)
1. 보낸 메시지 에코의 이미지 미리보기 `URL.createObjectURL`을 해제하지 않는다 → 서버 사본이 오면(에코가 대체될 때) 또는 화면 이탈 시 `revokeObjectURL`.
2. 첨부만 있고 글이 없으면 보낼 수 없다(현재 의도적 제한 — 라우팅이 빈 문장을 판정함). 첨부만 있을 때 보낼 수 있게 하되 라우터에 "첨부 N개(이름)" 요약 문장을 넘기도록 검토. **[구현 전 확인]** 서버 `chat.send`가 빈 `content`를 받는지.
3. 첨부만 있는 user 메시지는 길게 누르기가 안 된다(`text`가 비면 핸들러 없음) → 첨부 묶음에도 길게 누르기.
4. `ChatScreen`에 화면 단위 테스트가 없다(수정·분기·대기열 자동 전송·첨부 업로드 실패 시 복구) → `tests/chatScreen.test.tsx` 추가(`@/modules/chat-core`·`@/modules/aidev-router` mock, `screens.test.tsx` 방식).
5. 대화 목록이 첫 화면이라 검색·시트 코드가 메인 청크에 들어갔다(120→129KB). 예산 안이지만 `ConversationSearch`는 lazy로 빼도 된다.
6. 기존부터 모바일 lazy 청크에 `xterm`(289KB)·`mermaid`·`cytoscape`가 있다(초기 청크 아님 → 검사 통과). 어느 import가 끌고 오는지 `vite build --config vite.mobile.config.js` + rollup visualizer 또는 `dist-mobile/assets/*.js`에서 import 체인 추적 → 원인 제거(계획서 §3.11 금지 라이브러리).

---

## 4. 남은 작업

### C-12.5 대화 화면 ⋯ 확장 (배치: 상단 바 ⋯ = 대화 시트에 항목 추가)
- **토큰 사용량**: `api.providers.sessionTokenUsage(sessionId)`(`GET /api/providers/sessions/:id/token-usage`) + 실시간 `setTokenBudget`(ChatScreen이 이미 `useChatRealtimeHandlers`에 넘김, 지금은 버림). 시트에 사용량/한도 표시. 컨텍스트가 80%를 넘으면 입력창 위에 한 줄 경고(바로 써야 하는 정보 → 화면 노출). **[구현 전 확인]** 응답 형태: `server/modules/providers/services/provider-token-usage.service.ts`.
- **내보내기(Markdown)**: 작업대 `src/modules/chat/export/buildTranscriptMarkdown.ts`는 `@/modules/chat/tools`(React 렌더러 묶음)를 import 한다 → **chat-core로 그대로 re-export 하지 말 것**. 모바일용 경량 빌더를 `src-mobile/lib/exportMarkdown.ts`로(NormalizedMessage → md: 사용자/assistant 텍스트, 툴은 이름+요약 한 줄) 만들고 `navigator.share({files:[File]})`(지원 시) 또는 `<a download>`로 저장. HTML 내보내기는 작업대에 남긴다(React 렌더 필요).
- **예약 메시지**: `api.scheduledMessages.list(sessionId)`, `.create({sessionId, content, scheduledFor(ISO), options})`, `.cancel(id)`. 배치 — 만들기: **보내기 버튼 길게 누르기 → "예약 보내기" 시트**(시각 선택, 송신 옵션은 `buildSendOptions`와 같게) / 목록·취소: ⋯ 시트의 "예약된 메시지 N". **[구현 전 확인]** `options` 형태는 작업대 `composer/useScheduledMessages.ts`.

### C-12.6 입력창 자동완성·음성 (배치: 입력창 안 — 바로 쓰는 기능)
- **`/` 명령**: 입력이 `/`로 시작하면 입력창 위 제안 목록. 목록 = `api.commands.list(projectPath)` → `{builtIn, custom}` + 스킬 `api.providers.skills(provider, {workspacePath})`(`data.skills`). 실행 = `api.commands.execute({commandName, commandPath, args, context:{projectPath, projectId, sessionId, provider, model, tokenUsage}})` → `type:'builtin'`이면 `action`(`help|models|cost|status|memory|config`)별 결과를 시트로, `type:'custom'`이면 `content`를 보낸다(`hasBashCommands`면 확인 시트). 사용 빈도 정렬은 작업대 `hooks/useSlashCommands.ts` 참고(로컬 기록 키를 공유할지 결정).
- **`@파일` 멘션**: `@` 입력 → `api.getFiles(projectId)`(gitignore 반영 트리) 평탄화 후 퍼지 검색, 선택 시 `@상대경로` 삽입. 결과는 프로젝트별로 캐시. 작업대 `hooks/useFileMentions.tsx`의 평탄화 규칙과 같게.
- **음성 입력**: 입력창 🎤(가용할 때만). 녹음 `MediaRecorder` → `transcribeVoice(blob, name)`(`@/shared/api`, 사용자 OpenAI 호환 엔드포인트 또는 서버 프록시) → 텍스트를 입력창에 추가. 가용성 = `api.voice.health()` + `@/shared/voiceConfig`. 작업대 `useVoiceAvailable`은 `UiPreferencesContext`에 의존하므로 모바일에 그대로 쓰지 말고 `src-mobile/lib/voice.ts`로 같은 판정을 구현. iOS는 사용자 제스처 안에서 녹음 시작.
- 입력창 줄이 넘치지 않게: 📎 · 🎤 · 모드 알약 · (여백) · 중지 · 보내기. 좁으면 모드 알약은 아이콘만.

### C-12.7 툴 결과 카드 (배치: 대화 안 — 바로 보는 정보)
`MessageBubble`의 `tool_use` 분기에서 이름별 전용 카드(나머지는 지금처럼 접힌 JSON):
- `TodoWrite`(Codex `update_plan`·`todo_list`도 서버가 이 이름으로 통일): `input.todos[{content, status, activeForm}]` → 체크리스트, 접힘 제목 = 진행 중 항목. 대화에서 **가장 최근 Todo**를 입력창 위 한 줄 진행 표시로(탭하면 펼침).
- `Task`(서브에이전트): 제목 `서브에이전트 / {subagent_type}: {description}`, 펼치면 결과 본문(markdown). **[구현 전 확인]** 서브에이전트 내부 툴 표시 방식은 작업대 `tools/SubagentPanel.tsx`.
- `ExitPlanMode`: 계획 본문 markdown(승인은 C-12.2 시트).
- `AskUserQuestion`: 질문과 **내가 고른 답**을 카드로.
- `Edit/Write/MultiEdit`: 이미 있는 diff peek 유지.
작업대 `tools/configs/toolConfigs.ts`의 제목 규칙과 맞춘다.

### C-12.8 git 변경 사항 시트 (배치: 프로젝트 화면 상단 바 아이콘 + 대화 화면 ⋯ "변경 사항")
- API(`api.git.*`, 모두 `project` = projectId): `status` → `{branch, modified, added, deleted, untracked, staged…}`, `diff(projectId, file)`, `stage/unstage(files)`, `commit(message, files)`, `generateCommitMessage(files, provider)`, `fetch/pull/push`, `branches`, `checkout(branch)`, `remoteStatus`.
- 시트: 브랜치·앞섬/뒤처짐 → 파일 목록(체크로 포함 여부, 탭하면 기존 `DiffPeek`로 diff) → 커밋 메시지(✨ 자동 생성) → 커밋 → 푸시. 실패 메시지는 서버 문구 그대로.
- **[구현 전 확인]** `status`·`diff`·`remoteStatus` 응답 정확한 필드: `server/modules/git/git.routes.ts`(`/status` 332행 부근, `/commit` 618행 부근). 파괴적 동작(`discard`, `deleteUntracked`, `revertLocalCommit`, 브랜치 삭제)은 확인 시트 필수.

### C-12.9 설정 보강 (배치: 설정 화면만)
- "허용 규칙": `getClaudeSettings().allowedTools` 목록, 항목 삭제(= `claudePermissions` 갱신 — 작업대와 공유). Codex는 `codexPermissions`.
- "음성": 사용 여부·엔드포인트 상태(C-12.6과 같은 판정), 읽어 주기 목소리.
- 현재 설정 섹션: 라우팅·effort 상한·엔진·알림·푸시·화면·계정 — 위 두 섹션을 엔진 다음에 추가.

### C-12.10 실기기 확인 (계획서 C-11과 함께)
iPhone 세로(설치형 PWA 포함)에서: 질문 답하기, 항상 허용 후 같은 명령 재실행 시 묻지 않음, 응답 중 대기열, 사진 첨부, 긴 대화 위로 스크롤, 메시지 수정·분기, 대화·프로젝트 시트, 검색, 프로젝트 추가(폴더·복제), 화면 전환 시 스플래시 없음. 스크린샷은 `ops/inbox/`로 회수.

---

## 5. 완료 기준과 보고

- 항목별: §1-5 검증 명령 전부 통과(실패·건너뜀은 이유와 함께 보고), 새 동작마다 테스트 1개 이상, 계획서 항목 상태 갱신, 커밋.
- C-12 전체 완료: C-12.10 실기기 확인, 모바일 초기 청크 크기 기록, "작업대에서만 가능한 채팅·프로젝트 기본 기능" 목록이 **코드 보기/작성 UI만** 남음.
- 보고 맨 앞: 푸시 여부(`git ls-remote origin main` 해시), 이어서 항목별 결과·남은 위험.
