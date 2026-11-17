# AI 분석 API (계약 v1)

외부 서버(LEDgo 등)가 **데이터와 관련 이미지**를 보내 **정해진 JSON 모양으로** 분석 결과를 받는 API다.
원본 도면 파일(DWG·DXF 등)은 보내지 않는다 — 부르는 쪽이 데이터로 바꿔 `task.prompt` 에 넣고, 렌더링한 이미지(또는 PDF)를
`inputs` 에 함께 싣는다. 모델은 각 입력을 `[input i/n: 이름 (mime)]` 줄 뒤에서 보므로 과제에서 이름으로 가리킬 수 있다.
규범은 LEDgo 가 건넨 "AI 분석 계약 v1" 문서이고, 적합성 검사기(`ai-contract-check.mjs`)로 맞는지 확인한다.

```
POST https://dev.nado.work/ai/v1/analyze          → 202 { jobId }  (같은 requestId + 같은 본문 → 200 저장된 답, costUsd 0)
GET  https://dev.nado.work/ai/v1/analyze/{jobId}  → running | done { data, text } | error
Authorization: Bearer <analyze 키>
```

## 누구의 무엇으로 도는가

- **부른 NadoVibe 계정**의 런타임에서, 그 계정의 **Claude 구독**으로 돈다. API 요금(API 키)은 쓰지 않는다.
- 모델은 **그 계정의 설정**으로 고른다(`POST /api/aidev/analyze/pick`): Claude 허용·로그인·사용량 한도 →
  provider policy 또는 티어 표(요청의 `effort` 힌트 low/medium/high = D1/D2/D3) → 모델 하한 → effort 상한.
  요청의 `model` 힌트는 쓰지 않는다. PDF 를 직접 읽는 것은 Claude 턴뿐이라 분석은 Claude 로만 돈다.
- 도구 없는 한 턴(`tools: []`, `maxTurns: 1`, `persistSession: false`) — 채팅 목록에 남지 않는다.

## 키 발급 (관리자)

서버에서(비밀번호 없이, 토큰은 한 번만 출력):

```sh
./relay.sh sh  # 또는 AI-PC 셸에서
docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js api-key <관리자 계정> ledgo@analyze
```

또는 HTTP 로:

```sh
read -rs PW
TOKEN=$(curl -sS https://dev.nado.work/api/auth/login -H 'content-type: application/json' \
  -d "{\"username\":\"<관리자 계정>\",\"password\":\"$PW\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -sS https://dev.nado.work/api/aidev/keys -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"ledgo","scope":"analyze"}'      # token 은 이 응답에만 나온다
```

키는 발급한 계정의 것이다. `analyze` 키는 `/ai/v1/*` 외에는 어디에도 닿지 않는다(`/api` 는 전부 403).
폐기: `DELETE /api/aidev/keys/<id>`. 계정을 끄면 그 계정의 키도 즉시 막힌다.

## 상한

| 항목 | 값 | 넘으면 |
| --- | --- | --- |
| 요청 본문 | 34 MB (게이트웨이, Content-Length 로 먼저 판정) | 413 `too_large` |
| task.system·task.prompt (데이터 포함) | 각 500,000자 | 413 `too_large` |
| inputs 개수 | 20개 (넘으면 Claude 가 모든 이미지를 2000px 로 줄인다) | 413 `too_large` |
| inputs 합계 | 22 MB (Claude 요청 32 MB 안에 base64 로 들어가는 크기) | 413 `too_large` |
| PNG·JPEG·GIF·WebP | 장당 5 MB, 내용이 mime 과 맞아야 함 | 413 / 415 |
| PDF | 22 MB | 413 `too_large` |
| 텍스트 | 1 MB | 413 `too_large` |
| 그 밖의 형식 | 받지 않는다 (데이터로 바꿔 prompt 에) | 415 `unsupported_media` |
| 동시 분석 | 계정당 1건 + 대기 2건 | 429 `rate_limited` |
| 한 턴 | 10분 (스키마 재시도 1회는 따로) | 504 `timeout` |
| 결과 보관 | 48시간 (성공만) | 다시 분석 |

## 격리 — 기존 서비스에 닿지 않게

- 게이트웨이는 인증하고 **스트리밍으로 넘기기만** 한다(본문 파싱·버퍼링 없음). 계약 로직은 전부 런타임
  `server/modules/ai-analyze/` 에 있다 — 영향 범위는 부른 계정의 런타임 하나.
- 결과 테이블(`ai_analyze_requests`)은 그 모듈이 처음 쓸 때 만든다. 런타임 스키마·마이그레이션에 없다.
- 사용량 한도·라우팅 상태는 **읽기만** 한다. 분석이 채팅 라우팅을 바꾸지 않는다.

## 끄기 (재배포 없이)

게이트웨이 DB `app_kv` 의 `ai_analyze` 를 `off` 로 두면 `/ai/v1/*` 가 바로 `503 unavailable` 로 답한다
(요청마다 읽으므로 재시작도 필요 없다). 지우면 다시 켜진다. 키를 폐기해도 그 키의 호출은 즉시 막힌다.

## 검사

```sh
node ai-contract-check.mjs https://dev.nado.work/ai --token "$KEY"
```
