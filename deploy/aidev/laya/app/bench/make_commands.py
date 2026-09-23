"""Generates commands.jsonl — the routing benchmark set (IMPLEMENTATION-PLAN §3.9).

12 routing agents x (5 Korean + 5 English) = 120 labelled commands. Labels:
  agent      the seed agent that should win
  depth      0..4 (§3.1 scale)
  task_kind  bulk_read | implement | debug | refactor | design | ops | explain
Run once (python make_commands.py) and commit the output; bench.py reads commands.jsonl.
"""
import json

# (agent, [(text, depth, task_kind), ...])  — 5 ko + 5 en each
SETS = {
    "frontend-react": [
        ("React 컴포넌트에 다크모드 토글 훅을 추가해줘", 1, "implement"),
        ("이 페이지 렌더링이 느린데 useMemo 없이 원인을 찾아서 고쳐줘", 3, "debug"),
        ("Tailwind로 카드 리스트를 3열 그리드로 바꿔줘", 1, "implement"),
        ("useEffect 안에서 setState 경고가 나는 이유를 설명해줘", 0, "explain"),
        ("채팅 화면을 컴포넌트 단위로 분리하고 상태를 컨텍스트로 옮기는 리팩터링을 해줘", 3, "refactor"),
        ("Add a debounced search input component with keyboard navigation", 2, "implement"),
        ("Why does this React list re-render every item when one changes?", 1, "explain"),
        ("Fix the hydration mismatch error on the settings page", 2, "debug"),
        ("Split the 900-line Dashboard.tsx into feature modules without changing behavior", 3, "refactor"),
        ("Make the modal accessible: focus trap, ESC to close, aria attributes", 2, "implement"),
    ],
    "backend-node": [
        ("Express API에 rate limit 미들웨어를 추가해줘", 1, "implement"),
        ("웹소켓 연결이 5분 후에 끊기는 문제를 찾아서 고쳐줘", 3, "debug"),
        ("파일 업로드 엔드포인트를 스트리밍 방식으로 바꿔줘", 2, "refactor"),
        ("이 서비스 계층 구조에서 라우트와 서비스 책임을 어떻게 나눌지 설계해줘", 3, "design"),
        ("JWT 리프레시 토큰 흐름을 설명해줘", 0, "explain"),
        ("Add a POST /api/projects endpoint with validation and error envelope", 2, "implement"),
        ("The server leaks memory after many websocket reconnects; find the cause", 3, "debug"),
        ("Move business logic out of the route handlers into services", 2, "refactor"),
        ("Design the API for scheduling messages with retries and idempotency", 3, "design"),
        ("What does express.json() limit default to?", 0, "explain"),
    ],
    "database": [
        ("SQLite 스키마에 agent_versions 테이블을 추가하는 마이그레이션을 작성해줘", 1, "implement"),
        ("이 쿼리가 풀스캔을 하는데 인덱스를 설계해줘", 2, "debug"),
        ("주문 테이블을 파티셔닝할지 판단하고 설계안을 만들어줘", 3, "design"),
        ("FTS5 가상 테이블과 트리거를 설명해줘", 0, "explain"),
        ("Postgres로 옮기기 위한 스키마 변환 계획을 세워줘", 4, "design"),
        ("Write a migration adding a unique index on (user_id, name)", 1, "implement"),
        ("EXPLAIN shows a nested loop on a 2M row join; optimize it", 3, "debug"),
        ("Normalize the settings table that stores JSON blobs into proper columns", 3, "refactor"),
        ("What isolation level does SQLite use in WAL mode?", 0, "explain"),
        ("Design a schema for versioned documents with soft delete", 2, "design"),
    ],
    "devops": [
        ("docker compose에 헬스체크와 재시작 정책을 추가해줘", 1, "ops"),
        ("배포 후 컨테이너가 계속 재시작되는 원인을 찾아줘", 3, "debug"),
        ("nginx 리버스 프록시에 웹소켓 업그레이드 설정을 넣어줘", 1, "ops"),
        ("무중단 배포를 위한 릴리스 볼륨 구조를 설계해줘", 4, "design"),
        ("systemd 서비스 파일에서 Restart=always와 on-failure 차이를 설명해줘", 0, "explain"),
        ("Write a bash script that rotates logs and prunes old docker images", 2, "ops"),
        ("The cron backup job silently stops after the first pipe failure; fix the script", 2, "debug"),
        ("Set up a wildcard TLS certificate renewal with the existing proxy", 2, "ops"),
        ("Plan a rollback procedure for the release volume deployment", 3, "design"),
        ("How do I see why a container exited?", 0, "explain"),
    ],
    "tizen-device": [
        ("타이젠 TV 앱을 sdb로 설치하고 dlog 로그를 확인하는 절차를 알려줘", 1, "ops"),
        ("갤럭시 워치 앱이 설치 후 바로 종료되는데 원인을 찾아줘", 3, "debug"),
        ("Tizen 웹앱 config.xml에 네트워크 privilege를 추가해줘", 1, "implement"),
        ("타이젠 인증서 프로필 생성 방법을 설명해줘", 0, "explain"),
        ("TV 리모컨 키 이벤트 처리 모듈을 만들어줘", 2, "implement"),
        ("Package this Tizen web app and install it on the connected TV", 1, "ops"),
        ("sdb connect times out to the watch; diagnose it", 2, "debug"),
        ("Explain the Tizen wearable app lifecycle callbacks", 0, "explain"),
        ("Build a Tizen TV navigation layer for 5-way remote focus", 3, "implement"),
        ("Which Tizen version supports the Samsung Product API for TV?", 0, "explain"),
    ],
    "android-device": [
        ("안드로이드 앱에서 카메라 권한 요청 흐름을 구현해줘", 2, "implement"),
        ("adb logcat에서 이 크래시 스택트레이스의 원인을 찾아줘", 3, "debug"),
        ("gradle 빌드가 의존성 충돌로 실패하는데 해결해줘", 2, "debug"),
        ("Jetpack Compose 상태 호이스팅을 설명해줘", 0, "explain"),
        ("에뮬레이터에 APK 설치하고 실행하는 명령을 알려줘", 0, "ops"),
        ("Add a foreground service that keeps the upload running", 2, "implement"),
        ("The app is killed in the background on Android 14; fix battery restrictions handling", 3, "debug"),
        ("Migrate the Gradle build to Kotlin DSL with a version catalog", 3, "refactor"),
        ("Explain runtime permissions vs manifest permissions", 0, "explain"),
        ("Build a release AAB signed with the upload key", 1, "ops"),
    ],
    "testing": [
        ("이 훅에 대한 Vitest 단위 테스트를 작성해줘", 1, "implement"),
        ("Playwright e2e 테스트가 CI에서만 가끔 실패하는 원인을 찾아줘", 3, "debug"),
        ("로그인 흐름의 e2e 테스트를 추가해줘", 2, "implement"),
        ("테스트 커버리지 리포트에서 우선 채워야 할 부분을 알려줘", 1, "explain"),
        ("테스트 픽스처를 공유 헬퍼로 정리해줘", 2, "refactor"),
        ("Write integration tests for the /api/projects endpoints", 2, "implement"),
        ("This test passes locally but fails in CI with a timeout; make it deterministic", 3, "debug"),
        ("Mock the websocket in the chat tests without touching production code", 2, "implement"),
        ("What is the difference between vi.mock and vi.spyOn?", 0, "explain"),
        ("Refactor the test suite to use a shared server fixture", 2, "refactor"),
    ],
    "docs": [
        ("이 모듈의 README를 작성해줘", 1, "explain"),
        ("API 엔드포인트 문서를 표로 정리해줘", 1, "explain"),
        ("배포 절차를 운영자용 문서로 만들어줘", 2, "explain"),
        ("이 영어 설계 문서를 한국어로 번역해줘", 1, "explain"),
        ("변경 이력(CHANGELOG)을 최근 커밋 기준으로 정리해줘", 1, "explain"),
        ("Write the architecture overview document for the gateway", 2, "explain"),
        ("Document the environment variables in a table", 1, "explain"),
        ("Turn these code comments into a user guide", 2, "explain"),
        ("Draft release notes for version 1.4", 1, "explain"),
        ("Improve the wording of this onboarding guide", 1, "explain"),
    ],
    "mobile-responsive": [
        ("모바일에서 채팅 입력창이 키보드에 가려지는 문제를 고쳐줘", 2, "debug"),
        ("이 화면을 360px 폭에서 깨지지 않게 반응형으로 만들어줘", 2, "implement"),
        ("PWA 매니페스트와 서비스 워커를 추가해서 설치 가능하게 해줘", 2, "implement"),
        ("iOS 사파리에서 100vh가 다르게 동작하는 이유를 설명해줘", 0, "explain"),
        ("터치 타깃 크기와 safe-area를 점검해서 고쳐줘", 1, "implement"),
        ("Make the sidebar a bottom sheet on phones", 2, "implement"),
        ("The sticky header jumps on iOS when scrolling; fix it", 2, "debug"),
        ("Reduce the mobile bundle: this page loads 3MB of JS", 3, "refactor"),
        ("Explain safe-area-inset and when to use dvh", 0, "explain"),
        ("Add swipe gestures to switch between panels on tablets", 2, "implement"),
    ],
    "security-review": [
        ("이 인증 미들웨어의 보안 취약점을 점검해줘", 2, "explain"),
        ("경로 조작(path traversal) 공격이 가능한지 파일 API를 검토해줘", 2, "explain"),
        ("업로드된 파일명으로 인한 인젝션 위험을 막아줘", 2, "implement"),
        ("CSRF 토큰이 필요한 이유를 설명해줘", 0, "explain"),
        ("의존성 취약점 보고서를 보고 위험도 순으로 조치 계획을 세워줘", 2, "design"),
        ("Review the session cookie settings for security issues", 1, "explain"),
        ("Harden the docker socket access in this stack", 2, "ops"),
        ("Check this SQL builder for injection risks and fix them", 2, "debug"),
        ("Why should secrets never be passed as command-line arguments?", 0, "explain"),
        ("Audit the websocket auth handshake for token leakage", 2, "explain"),
    ],
    "git-workflow": [
        ("이 브랜치를 main 위로 rebase 하고 충돌을 해결해줘", 2, "ops"),
        ("실수로 삭제한 커밋을 reflog로 복구해줘", 1, "ops"),
        ("upstream 포크와 동기화하면서 우리 커밋을 유지하는 방법을 알려줘", 2, "explain"),
        ("커밋 3개를 하나로 합쳐줘", 1, "ops"),
        ("git bundle로 백업을 만들고 복원하는 절차를 설명해줘", 0, "explain"),
        ("Cherry-pick the hotfix commits onto the release branch", 1, "ops"),
        ("Find which commit introduced the regression with bisect", 2, "debug"),
        ("Explain rebase vs merge for a long-lived feature branch", 0, "explain"),
        ("Set up conventional commit messages with a commit-msg hook", 1, "ops"),
        ("Remove a leaked secret from the git history safely", 3, "ops"),
    ],
    "ai-integration": [
        ("Claude Agent SDK로 서브에이전트를 정의하고 호출하는 코드를 작성해줘", 2, "implement"),
        ("MCP 서버를 stdio로 만들고 도구 스키마를 정의해줘", 2, "implement"),
        ("Laya 같은 소형 결정 모델을 라우팅에 쓰는 방식을 설계해줘", 3, "design"),
        ("프롬프트가 길어져서 비용이 늘었는데 컨텍스트 예산을 줄이는 방법을 제안해줘", 2, "design"),
        ("Codex SDK에서 developer_instructions 설정이 뭔지 설명해줘", 0, "explain"),
        ("Stream tool-call events from the agent SDK to the websocket client", 2, "implement"),
        ("The agent loops calling the same tool forever; add a guard", 2, "debug"),
        ("Design a lesson-learning loop that feeds failures back into prompts", 3, "design"),
        ("Explain the difference between system prompt append and a custom agent prompt", 0, "explain"),
        ("Register an MCP server for both Claude and Codex without editing config files", 2, "implement"),
    ],
}

# task_kind-only probes (agent label = generalist): bulk reading must be recognised
EXTRA = [
    ("generalist", "이 로그 파일 5만 줄을 읽고 오류 패턴을 요약해줘", 2, "bulk_read"),
    ("generalist", "저장소 전체 코드를 훑어서 사용하지 않는 함수를 목록으로 뽑아줘", 2, "bulk_read"),
    ("generalist", "Read all 300 issue reports and cluster them by root cause", 2, "bulk_read"),
    ("generalist", "Summarize the 40 CSV exports in the data folder", 2, "bulk_read"),
    ("generalist", "오늘 날짜가 뭐야?", 0, "explain"),
    ("generalist", "package.json의 버전을 1.5.0으로 올려줘", 0, "implement"),
]

rows = []
for agent, items in SETS.items():
    for text, depth, kind in items:
        rows.append({"text": text, "agent": agent, "depth": depth, "task_kind": kind, "lang": "ko" if any("가" <= c <= "힣" for c in text) else "en"})
for agent, text, depth, kind in EXTRA:
    rows.append({"text": text, "agent": agent, "depth": depth, "task_kind": kind, "lang": "ko" if any("가" <= c <= "힣" for c in text) else "en"})
with open("commands.jsonl", "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"wrote {len(rows)} commands")
