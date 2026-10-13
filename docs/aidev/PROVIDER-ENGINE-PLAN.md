# 공급자(엔진) 확장과 정책 라우팅 — 작업 계획·체크리스트 (G, 2026-10-13)

> `IMPLEMENTATION-PLAN.md`의 단계 **G**를 자세히 적은 작업 문서다. 항목 ID(G1-03 …)로 추적하고,
> 완료하면 `[x]`와 릴리스 ID를 적는다. **서버에서 확인된 것만 [x]**로 한다(원칙 9).
> 여기 없는 일을 하게 되면 먼저 이 문서를 고친다.
> 2026-10-13 개정: Q1(공급자 순서 엄수, 한도일 때만 다음)·Q2(상한 미달이면 상한·최대 강도) 사용자 결정 반영 — §0, §2, §3.1~3.4, G3-05·G3-06, G5, §8, §9.
> 2026-10-13 개정 4: 사용자 결정 "claude·codex를 이 구조로 먼저 맞추고 opencode는 그 위에" — 단계 **GP**(§5 맨 앞)로 정책 구조를 먼저 구현. 구현하며 바뀐 설계: 분할 모드 전환 조건 = 모델 사다리 설정(§2.1), 점수 표는 지수별 열(§3.1), AA 무료 한도 하루 100회.
> 2026-10-13 개정 3: 점수 지수 기본 Coding Index(사용자 변경 가능), 실행 불가 공급자는 알림 없이 건너뜀 — §2.1, §2.2, §3.1·3.2, G5-02a·G5-10, §9 Q12·Q13.
> 2026-10-13 개정 2: "가중치 단계 = 추론 강도" 확인, 강도 하한 추가, 분할 기준을 지능 점수(Artificial Analysis)로 — §0, §2.1, §2.3, §3.1~3.4, G0-09, G5-02a·G5-02b, §8, §9 Q13~Q15.
> 코드 위치(`파일:줄`)는 `6465ed5e`(2026-10-13) 기준이다. 작업 전에 현재 코드를 다시 읽고 줄 번호를 확인한다.

---

## 0. 목표와 범위

### 사용자 결정 (2026-10-13)
> "cursor 연결은 설정에서 숨기고 opencode를 claude, gpt와 같은 수준으로 연결을 구현할거야. 최종적으로는 공급자별로 가중치와 상한 하한을 정하게 하고 모델의 우선순위를 정하게 할거고 작업 우선순위 공급자, 검증 우선순위 공급자를 정해서 공급자와 모델을 우선순위에 따라 유동적으로 선택하게 할거야."

> (Q1) "공급자의 우선순위는 반드시 지켜져야하고 한도에 걸릴 때만 다음순위로 넘기는거다. 모델의 하한선을 기준으로 상한선까지 균등분할하되 모델과 가중치 단계 조합을 난이도에 따라 선택하게한다."
> (Q2) "상한이 필요한 깊이에 못 미친다면 상한에 최대가중치를 선택하게 한다."
> (추가) "모델의 하한, 상한 그리고 강도의 하한, 상한을 설정할 수 있게 제공해야 해." / "지능 점수로 환산할 수 있는 기준이 있다면 그 점수를 기준으로 분할하면 좋겠다."

**용어 정리.** **"가중치 단계" = 추론 강도(effort) 단계**다(low → medium → high → xhigh → max …, 사용자 확인 2026-10-13). Q2의 "최대가중치"는 상한 모델의 가장 높은 추론 강도다. 처음 결정의 "공급자별 가중치"도 같은 뜻으로 보고, 공급자 선호 점수(가중치 슬라이더)는 두지 않는다. 공급자 선택은 Q1에 따라 순서로만 정한다(§9 Q1).

### 목표 (완료 조건)
1. **Cursor 숨김**: 설정·provider 선택기·온보딩에서 Cursor가 보이지 않는다. 옛 Cursor 세션은 지금처럼 열리고 표시된다.
2. **OpenCode 동급 연결**: OpenCode(Go·Zen 등 로그인)가 Claude·Codex와 같은 기능으로 돈다.
   - 범위: 라우팅 대상, 전문 agent 지시문·교훈·지식, aidev-tools MCP(원격 실행·기기·미리보기), 모델 하한·effort 상한, 사용량 한도 감지와 인계, 독립 검증, 실패 학습, 우선순위 복귀.
3. **공급자 정책 라우팅**: 사용자가 다음을 정하면 게이트웨이가 명령마다 공급자와 모델을 정책에 따라 고른다.
   - 공급자별: **모델 하한·상한, 강도 하한·상한, 모델 사다리(쓸 모델과 약→강 순서)**
   - **작업 우선순위 공급자 순서**: 반드시 지킨다. **사용량 한도에 걸렸을 때만** 다음 순위로 넘긴다(Q1).
   - **검증 우선순위 공급자 순서**: 같은 규칙이다.
   - 공급자 안에서는 [모델 하한~상한] × [강도 하한~상한]의 (모델, 강도) 조합을 **지능 점수로 환산해 점수 구간을 균등분할**하고, 명령 난이도(D0~D4)에 맞는 조합을 고른다(Q1, §2.3).
   - 지능 점수는 공개 지표 **Artificial Analysis Coding Index**를 기본으로 쓰고, 사용자가 Intelligence·Agentic Index로 바꿀 수 있다(모델·강도 조합별 점수가 있다). 점수가 없으면 칸 수 균등분할로 대신한다.
   - 상한 모델이 그 난이도를 수월하게 해낼 등급에 못 미치면 다른 공급자로 넘기지 않고 **상한 모델 + 최대 강도**로 실행한다(Q2).

### 하지 않을 것
- Cursor 코드 삭제. 숨김만 하고 server와 타입은 그대로 둔다(옛 세션 렌더용).
- Google 구독 OAuth(Antigravity 플러그인) 연동. Google 약관 위반으로 계정 정지 사례가 있다(2026-02~). Gemini는 OpenCode Zen 또는 Google API 키로만 쓴다(§9 Q8).
- 판정(specialist judge)을 OpenCode로 돌리는 일. Claude→Codex를 유지한다(§9 Q4). 측정 근거가 생기면 별도 항목으로 다룬다.
- 원격 PC 위임(`remote_agent`)에 opencode를 추가하는 일(선택 항목 G2-15).

### 원칙 (IMPLEMENTATION-PLAN §0에 더해)
- **설정하지 않은 항목은 지금 동작 그대로**(§9 Q11): 작업 우선순위가 없는 계정은 지금처럼 학습 가중치 점수로 공급자를 고른다. 모델 하한·상한과 강도 하한을 하나도 정하지 않은 공급자는 지금의 등급표(`TIER_TABLE`, tier_policy, 하한 규칙)로 모델을 고른다(강도 상한만 정한 것은 지금도 있는 설정이라 등급표 모드를 유지한다). 정책을 하나도 설정하지 않은 계정은 Claude·Codex 선택 결과(엔진·모델·effort)가 지금과 같아야 하고, 동등성 테스트(G5-14)가 이를 확인하는 관문이다.
- **엔진 목록은 한 곳에서**: 게이트웨이는 `ENGINES`, 프런트는 `AIDEV_ENGINES`(새로 만듦), 런타임은 `sanitizeAidevOptions`의 화이트리스트에서만 정의한다. `['claude','codex']` 리터럴은 남기지 않는다.
- **이분법 금지**: "반대 엔진" 개념(`other = claude ? codex : claude`)을 없애고 "우선순위 순서에서 다음으로 쓸 수 있는 공급자"로 바꾼다.
- **런타임 도구는 이미지에**: opencode CLI는 런타임 이미지에 설치한다. npm 의존성으로는 넣을 수 없다. `opencode-ai`의 `bin/opencode.exe`는 postinstall이 실제 바이너리로 바꾸는 자리표시 셸 스크립트인데(실측: 1.19.0 tarball), 릴리스 deps가 `npm ci --omit=dev --ignore-scripts`(`deploy/aidev/release/release.sh:77`)라 실행 시 "postinstall script was not run" 오류가 난다.

---

## 1. 현재 구조 요약 (바꾸기 전에 알아야 할 것)

### 1.1 엔진 집합이 정의된 곳
| 계층 | 정의 | 위치 |
|---|---|---|
| 게이트웨이 | `type Engine = 'claude' \| 'codex'`, `ENGINES` | `deploy/aidev/auth-gateway/src/store-aidev.ts:8-9` |
| 런타임 | `AidevTurnOptions.engine: 'claude' \| 'codex' \| null`, sanitize 화이트리스트 | `server/modules/aidev-tools/aidev-tools.service.ts:257`, `:323` |
| 프런트 | `Engine = 'claude' \| 'codex'`, `ENGINES` | `src/modules/aidev-router/api.ts:8`, `hooks/useAidevRouting.ts:38` |
| provider(채팅) | `LLMProvider = 'claude' \| 'cursor' \| 'codex' \| 'opencode'` | `server/shared/types.ts:69`, `src/shared/types.ts:8` |

정의는 세 곳이지만, 실제 코드는 30곳 넘게 리터럴과 이분법으로 2엔진을 가정한다(부록 A). 상당수가 `as` 캐스트로 덮여 있어서 타입만 넓혀서는 컴파일러가 잡지 못한다.

### 1.2 현재 선택 알고리즘 (`POST /api/aidev/route`, `routing.ts:509`)
1. **가용성** (`aidev-api.ts:115-139`): 엔진마다 다음을 본다.
   - `allowed`: `accounts.engines`
   - `authenticated`: 런타임 `GET /api/providers/<engine>/auth/status`, 캐시 60초
   - `limited_until`: 최근 run의 `usage_limit_resets_at`. 0이면 started_at+5h
2. **깊이** (`routing.ts:594-711`): 판정 LLM의 `level`(없으면 Laya 점수)을 쓰고, 다음 값 중 가장 큰 쪽까지 올린다.
   - `KIND_MIN_DEPTH`, `agents.min_tier`, 채팅 직전 run depth, 생성 턴이면 3
3. **엔진 점수** (`:720-739`): `engine_weights[kind][engine]`(전역 학습값) + tier_policy 보정(±0.2) − 최근 1시간 실패(0.3)
4. **엔진 선택** (`:740-769`): 다음 순서로 첫 조건에 맞는 엔진을 고른다. 동점이면 `default_engine` → claude 순.
   - 세션 엔진 고정 → `preferEngine` → `accounts.engine_priority`의 첫 usable 엔진 → 최고 점수
5. **모델·effort** (`:771-789`): 다음을 차례로 적용한다.
   1. `TIER_TABLE[depth][engine]`(`routing.ts:104-110`)
   2. tier_policy 셀
   3. agent.model (같거나 강할 때만)
   4. 모델 하한 `applyModelFloor`(`:141`)
   5. effort 상한 `applyEffortCap`(`:120`). D4는 상한 값 그대로
   6. 명령에서 직접 지정한 값
6. **사후**
   - 실패하면 `decideNext`(`escalation.ts`)가 같은 엔진 재시도, 상위 등급, **반대 엔진** 중 하나를 고른다.
   - D2 이상이고 exit 0이면 독립 검증을 한다. 검증 엔진과 모델은 **런타임** `run-verifier.service.ts:56-89`가 정한다(작업자의 반대 엔진 우선).

### 1.3 설정이 저장되는 곳
| 설정 | 범위 | 저장 |
|---|---|---|
| 허용 엔진 | 계정 | `accounts.engines` CSV (DEFAULT `'claude,codex'`, `store-aidev.ts:57`) |
| 기본 엔진 | 계정 | `accounts.default_engine` |
| 엔진 우선순위 | 계정 | `accounts.engine_priority` JSON 배열 (`:183`) |
| effort 상한 | 계정 / 채팅 | `accounts.effort_cap`, `session_settings.effort_cap` JSON |
| 모델 하한 | 계정 / 채팅 | `accounts.model_floor`, `session_settings.model_floor` JSON |
| 채팅 엔진 고정 | 채팅 | `session_settings.pinned_engine` |
| 엔진 가중치 | **전역**(관리자) | `engine_weights(task_kind, engine, weight, prior, pinned, …)` |
| 등급 정책 | **전역**(관리자) | `tier_policy(domain, depth, engine, model, effort, …)` |

---

## 2. 목표 구조

### 2.1 개념
- **공급자(provider = engine)**: `claude`, `codex`, `opencode`. Cursor는 엔진이 아니다.
- **모델 카탈로그** `engine_models` (전역, 관리자 편집):
  - 공급자별 모델과 **능력 등급 `level`(0~4)**. level의 뜻은 "그 난이도까지 수월하게 해내는 모델"이다. 판정 LLM이 명령마다 내는 난이도 `level`(`specialist-judge.service.ts:70-76`의 등급 기준)과 같은 척도다.
  - 시드는 지금의 `TIER_TABLE`·`MODEL_LADDER`에서 만든다:
    - claude: haiku 0, sonnet 2, opus 3, best 4
    - codex: gpt-5.6-luna 0, gpt-5.6-terra 2, gpt-5.6-sol 3, gpt-6-astra 4
  - opencode 모델은 런타임 카탈로그(`opencode-models.provider.ts`)에서 가져오고, **측정 전 level은 2**로 둔다(§9 Q3). 관리자가 측정한 뒤 조정한다.
  - **모델별 강도 단계**:
    - 런타임 모델 카탈로그의 `effort.values`를 쓴다. claude haiku처럼 없으면 그 모델은 "기본 강도" 한 단계뿐이다.
    - 예: claude sonnet·opus·best는 low~max, codex는 low~ultra, opencode는 모델마다 다르다(GLM 5.3은 low·high·max).
    - 공급자·모델마다 단계 이름이 달라 하한·상한 비교는 공통 순서로 한다: `none < minimal < low < medium < high < xhigh < max < ultra`.
- **지능 점수** `model_scores` (전역, (모델, 강도) 조합마다 0~100):
  - 출처: Artificial Analysis(Intelligence Index v4.3.2, 2026-10). 지수는 **기본 Coding Index**, 계정 설정 `score_index`로 `coding | intelligence | agentic` 중에서 바꾼다(§9 Q13). 무료 API가 세 지수를 함께 주므로 모두 저장한다. 강도별로 따로 점수를 매긴다(예: "Claude Opus 5.5 (Xhigh)"). OpenCode 모델(GLM 5.3, Kimi K3 등)도 포함한다.
  - 무료 API `GET https://artificialanalysis.ai/api/v2/language/models/free`(헤더 `x-api-key`, **하루 100회**, 페이지당 200개)로 하루 1회 가져온다. 응답 항목은 `id`·`slug`·`name`("gpt-oss-20B (high)"처럼 강도 포함)·`evaluations.artificial_analysis_{coding,intelligence,agentic}_index`, 응답 머리에 `intelligence_index_version`. slug가 강도 변형끼리 같을 수 있어 매핑은 `id`를 우선 쓴다. **출처 표기가 의무**이므로 점수를 보여주는 화면에 "Artificial Analysis" 링크를 둔다.
  - 우리 모델 이름(별칭 `opus`, `best`, `opencode-go/glm-5.3` 등)과 강도를 AA 항목(slug)에 잇는 매핑은 관리자가 관리한다(시드 제공).
  - 출처 우선순위: 관리자 입력 > AA > 추정. 추정 규칙: 같은 모델의 다른 강도 점수 사이는 직선 보간한다. 한 강도만 있으면 같은 공급자의 강도별 평균 차이를 적용한다(§9 Q14). 추정값은 화면에 "추정"으로 표시한다.
  - 지수 버전이 바뀌면 척도가 달라지므로 같은 버전 점수끼리만 비교한다. 버전이 바뀌면 모든 점수를 함께 다시 가져온다(§9 Q15).
- **공급자 정책** (계정별, 선택적으로 채팅별 — §9 Q6)

  | 항목 | 뜻 | 정하지 않았을 때 |
  |---|---|---|
  | `ladder` | **모델 사다리(모델 우선순위)**: 쓸 모델과 약→강 순서. 사다리에 없는 모델은 쓰지 않는다 | 카탈로그 전체를 level 오름차순으로 |
  | `floor` | 하한 모델: 사다리에서 이 모델 아래는 쓰지 않는다 (기존 모델 하한) | 사다리의 첫 모델 |
  | `ceiling` | 상한 모델: 사다리에서 이 모델 위는 쓰지 않는다 (**신규**) | 사다리의 마지막 모델 |
  | `effort_floor` | 강도 하한: 이 강도 아래는 쓰지 않는다 (**신규**) | 모델의 가장 낮은 강도 |
  | `effort_cap` | 강도 상한 (기존 effort 상한) | xhigh (기존 기본값) |

  **모델 사다리를 정한 공급자만 분할 모드**다(구현 시 결정). 사다리가 없으면 하한·강도 상한을 정해 두어도 지금의 등급표 규칙(하한은 기존 의미)으로 고른다. 이유: 이미 모델 하한을 쓰는 계정(예: jazzlife opus/sol)이 배포만으로 분할 방식으로 바뀌지 않게 하기 위해서다. 설정 화면의 "범위 설정" 버튼이 사다리를 저장해 분할 모드로 바꾸고, "등급표로 되돌리기"가 사다리·상한·강도 하한을 지운다(§9 Q11).
- **작업 우선순위** `work_priority`: 공급자 순서. 기존 `accounts.engine_priority`를 쓴다.
  - 목록에 없는 공급자는 작업에 쓰지 않는다.
  - `null`이면 지금처럼 학습 가중치 점수로 고른다(§9 Q11).
- **검증 우선순위** `verify_priority`: 공급자 순서(**신규**).
  - `null`이면 지금처럼 작업자와 다른 공급자를 우선한다(교차 검증).
  - 정하면 그 순서를 그대로 따른다. 작업자와 같은 공급자가 1순위여도 순서를 바꾸지 않는다(Q1).

### 2.2 공급자 선택 — 순서는 반드시 지킨다 (Q1)
```
runnable(e) = allowed(e) ∧ authenticated(e)        # 실행 자체가 가능한가(권한·로그인)
limited(e)  = 사용량 한도 재설정 전                  # 넘기는 유일한 사유(Q1)

pickProvider(order):
  for e in order:
    if ¬runnable(e): 다음으로(사용자 알림 없음, 결정 기록에만 남김)   # §9 Q12
    elif limited(e): 사유 "e 한도(재설정 hh:mm)"를 기록하고 다음으로
    else: return e
  return 없음 → 전송 전에 사용자에게 알림("모든 공급자가 한도")

작업 공급자:
  1. 명령에서 model/engine을 직접 지정 → 그대로 (지금과 같음)
  2. 채팅을 사용자가 손으로 고정(pinned)했거나 preferEngine을 줌 → 그 공급자 (2026-10-09 결정: 수동 고정만 예외)
  3. 채팅이 공급자에 묶여 있음(sessionEngine):
       그 공급자가 한도 → plan.switch_back으로 pickProvider(work_priority) 제안 (G1-08)
       더 높은 순위 공급자가 한도에서 풀림 → plan.switch_back으로 그 공급자 제안 (기존 복귀 동작)
       그 밖에는 → 그 공급자 유지
  4. 새 채팅 → pickProvider(work_priority)
     work_priority가 null(정하지 않음) → 지금 방식(학습 가중치 점수, §1.2의 3·4)
```
- 다음 이유로는 순서를 바꾸지 않는다: 학습 가중치, 최근 실패(−0.3), tier_policy 성공률, 상한 미달. 작업 순서를 정한 계정에서는 점수 계산 자체를 하지 않는다.
- 판정(judge)은 작업 공급자 선택과 별개다(§2.5).

### 2.3 공급자 안의 모델·강도 선택 — 지능 점수 균등분할 (Q1·Q2)
```
입력: 공급자 e, 난이도 d ∈ {0..4} (판정 level, 하한 규칙 적용 후 — §1.2의 2)

steps(e) = [ (m, s) for m in ladder[e][model_floor..model_ceiling]       # 모델 하한~상한(사다리 순서)
                     for s in efforts(m) if effort_floor[e] ≤ s ≤ effort_cap[e] ]   # 강도 하한~상한(공통 순서로 비교)
           # 강도가 없는 모델(haiku 등)은 (m, 기본) 한 칸. 범위 안에 강도가 하나도 없으면 범위에 가장 가까운 강도 한 칸
           # 결과가 비면(설정 모순) 설정 저장 단계에서 막는다(400)

if d > level(model_ceiling[e]):                        # Q2: 상한 모델이 이 난이도를 수월하게 해낼 등급이 아님
    pick = (model_ceiling[e], min(effort_cap[e], 그 모델의 최대 강도))   # 상한 모델 + 최대 강도. 다른 공급자로 넘기지 않는다
elif 모든 칸에 점수가 있음(AA·관리자·추정):              # 점수 분할(기본)
    S = steps를 점수 오름차순으로(같은 점수면 약한 모델 → 낮은 강도 순)
    lo, hi = S[0].score, S[-1].score
    target = lo + d/4 × (hi − lo)
    pick = S에서 score ≥ target 인 첫 칸                 # 목표 점수 이상인 가장 싼 조합
else:                                                   # 점수가 없는 칸이 있음 → 칸 수 분할로 대신
    pick = steps[ round(d/4 × (|steps|−1)) ]            # steps는 사다리 순서 × 강도 순서
```
- **D0**은 범위에서 점수가 가장 낮은 조합, **D4**는 상한 모델의 최대 강도다(Q2와 같은 칸).
- 난이도가 오르면 목표 점수도 오르므로 고르는 조합의 점수는 내려가지 않는다(단조).
- 점수 순으로 고르기 때문에, 약한 모델의 높은 강도가 강한 모델의 낮은 강도보다 점수가 높으면 그 순서대로 쓰인다. 사다리 순서는 "어떤 모델을 쓸지"(포함 여부)와 칸 수 분할 대체 경로에만 쓰인다.
- **등급표 모드**(모델 하한·상한, 강도 하한을 하나도 정하지 않음)에서는 지금 규칙(`TIER_TABLE` → tier_policy → agent.model → 하한 → 강도 상한)을 그대로 쓴다.
- **분할 모드에서**
  - tier_policy(학습된 등급 보정)는 쓰지 않는다. 사용자가 정한 범위가 우선이다.
  - agent.model 고정은 범위 안에 있고 고른 조합보다 점수가 높거나 같을 때만 적용한다. 강도는 그 모델에서 목표 점수를 넘는 가장 낮은 강도로 한다.
- 채팅별 모델 하한(`session_settings.model_floor`)과 채팅별 강도 상한이 있으면 계정 값 대신 쓴다(기존 규칙).

**예시 1 — 점수 분할** (아래 점수는 설명용 **가상 값**이다. 실제 값은 AA 동기화 후 미리보기에서 확인한다)

모델 하한 sonnet · 상한 opus, 강도 하한 low · 상한 xhigh. 점수: sonnet low 40 / medium 45 / high 50 / xhigh 53, opus low 48 / medium 52 / high 55 / xhigh 56.

점수순 조합: sonnet·low 40 → sonnet·medium 45 → opus·low 48 → sonnet·high 50 → opus·medium 52 → sonnet·xhigh 53 → opus·high 55 → opus·xhigh 56 (lo 40, hi 56)

| 난이도 | 목표 점수 | 선택 |
|---|---|---|
| D0 | 40 | sonnet·low (40) |
| D1 | 44 | sonnet·medium (45) |
| D2 | 48 | opus·low (48) |
| D3 | 52 | opus·medium (52) |
| D4 | — | **opus·xhigh** (Q2: opus level 3 < 4) |

**예시 2 — 칸 수 분할(점수가 없을 때의 대체 경로)** (강도 상한 xhigh, claude 강도: haiku 없음, sonnet·opus·best low~max)

| 정책 | 칸(steps) | D0 | D1 | D2 | D3 | D4 |
|---|---|---|---|---|---|---|
| 지금(등급표 모드) | — | haiku | sonnet·medium | sonnet·high | opus·high | best·xhigh |
| 하한 haiku · 상한 best | haiku / sonnet 4단 / opus 4단 / best 4단 = 13 | haiku | sonnet·high (3) | opus·medium (6) | best·low (9) | best·xhigh (12) |
| 하한 sonnet · 상한 opus | sonnet 4단 / opus 4단 = 8 | sonnet·low | sonnet·high (2) | opus·low (4) | opus·medium (5) | **opus·xhigh** (Q2: opus level 3 < 4) |
| 하한 haiku · 상한 sonnet | haiku / sonnet 4단 = 5 | haiku | sonnet·low (1) | sonnet·medium (2) | **sonnet·xhigh** (Q2) | **sonnet·xhigh** (Q2) |

(괄호는 칸 번호 `round(d/4 × (n-1))`)
- 범위를 사다리 끝에서 끝까지 넓게 잡으면 지금보다 같은 난이도에 더 강한 조합을 쓴다. 비용과 한도 소진이 늘어나므로 설정 화면에서 D0~D4 미리보기를 보여준다(G5-05·G5-10).

### 2.4 검증 공급자 선택 (게이트웨이로 이동)
```
need = max(d, 3)                                   # 지금의 verifierModel 규칙: 3단 이상
if verify_priority:
    V = verify_priority                            # 정한 순서 그대로(Q1). 작업자 공급자도 자기 자리에
else:
    V = [작업자가 아닌 공급자들(work 순서) …, 작업자 공급자]   # 지금의 교차 검증(§9 Q11)
candidates = []
for e in V:
    if ¬runnable(e) or limited(e): continue        # 넘기는 사유는 한도(와 실행 불가)뿐
    (m, s) = §2.3 선택(e, need)
    if e == 작업자 공급자: (m, s)를 작업자 조합의 점수 이상으로 올린다(점수가 없으면 칸 순서로)
    candidates.append({engine: e, model: m, effort: s})
```
- 게이트웨이가 `candidates`를 런타임 `/api/aidev-tools/verify`에 넘긴다. 런타임은 순서대로 시도하고, 실행 오류·과부하·한도일 때만 다음 후보로 간다.
- 런타임에 중복으로 있는 `LADDER`·`verifierModel`·`verifierEngineOrder`(`run-verifier.service.ts:56-89`)는 제거한다.

### 2.5 부가 턴(side turn)의 공급자
| 턴 | 지금 | 목표 |
|---|---|---|
| 판정 (specialist judge) | 런타임: Claude sonnet → Codex terra (`specialist-judge.service.ts:305-315`) | 그대로(§9 Q4). 단, 허용 엔진 필터 버그를 고친다(G1-07) |
| agent 설계 (design) | 게이트웨이: `engine_priority + claude,codex` 순, D3 모델 (`aidev-api.ts:315-326`) | `pickProvider(work_priority)`, §2.3 선택(e, 3) |
| 교훈 정제 (curate) | 런타임: Claude haiku / Codex luna (`lesson-curator.service.ts:77-126`) | 게이트웨이가 `candidates`(작업 순서, 난이도 0)를 넘긴다 |
| 지식 점검 (knowledge) | 게이트웨이: claude sonnet / codex level 1 (`knowledge-refresh.ts:109-114`) | `pickProvider(work_priority)`, §2.3 선택(e, 1) |

### 2.6 실패 후 다음 단계 (`escalation.ts`)
- `retry_same`: 그대로 둔다.
- `escalate_tier`: **같은 공급자 안에서** 난이도를 d+1로 올려 §2.3으로 다시 고른다.
  - 이미 상한 모델·최대 강도이면 더 올릴 칸이 없으므로 `ask_user`로 간다.
  - 공급자를 바꾸지 않는다(Q1).
- `switch_engine`: **사용량 한도일 때만**(그리고 로그인 만료로 실행할 수 없을 때) `pickProvider`로 순서상 다음 공급자를 고른다.
  - 지금의 "D4에서 effort를 다 올려도 실패하면 다른 엔진으로"(`escalation.ts:66-72`, `:98`)는 없앤다. 그 경우는 `ask_user`다.
  - 단수 `other` 개념도 없앤다.
- 응답 `NextAction`에 `from_engine`을 추가한다. 프런트(`useEscalation.ts:101`)가 반대 엔진을 추측하지 않게 하기 위해서다.
- 작업 순서가 없는 계정(등급표·점수 모드)은 지금 규칙을 쓰되, "반대 엔진"은 "점수 순서상 다음 공급자"로 바꾼다.

### 2.7 OpenCode 런타임 어댑터 (런타임 `opencode-runtime.provider.js`)
Claude의 `applyAidevRouting`(`claude-runtime.provider.js:230-268`), Codex의 `buildCodexOptions`(`codex-runtime.provider.ts:300-323`)와 같은 역할의 `buildOpenCodeAidevConfig(options.aidev)`를 만든다.
- **실행 설정 주입**: `OPENCODE_CONFIG_CONTENT` 환경변수에 JSON을 넣는다. 파일 설정 뒤에 병합되며, 로컬 1.0.223 바이너리에서 존재를 확인했다. 대상 버전에서 다시 확인한다(G0-04). 지금의 `OPENCODE_PERMISSION` 주입 방식(`:37-48`, `:290-294`)과 같은 경로다.
  ```json
  {
    "mcp": {
      "aidev-tools": { "type": "local", "command": ["<cmd>", "...args"], "environment": { "...": "getMcpServerConfig().env" }, "enabled": true },
      "<agent 전용 MCP>": { "type": "local|remote", "...": "..." }
    },
    "agent": {
      "aidev-<agent name>": { "prompt": "<composeAgentInstructions(aidev)>", "tools": { "bash": true, "...": "..." }, "maxSteps": 0, "model": "<선택>" }
    }
  }
  ```
  그리고 `--agent aidev-<name>`으로 실행한다.
  - aidev-tools MCP는 aidev가 없어도 주입한다. Claude·Codex와 같다.
- **확인할 것** (G0):
  1. agent `prompt`가 기본 시스템 프롬프트를 대체하는지, 덧붙이는지. 대체한다면 `instructions`(임시 파일)로 덧붙이는 방식으로 바꾼다.
  2. `plan` 모드가 `--agent plan`(`:39-40`)과 충돌한다. aidev agent가 있으면 plan은 agent의 `permission.edit/bash = 'deny'`로 표현한다.
  3. MCP 도구를 승인 없이 호출할 수 있는지. 호출 타임아웃이 remote_exec 최대 45분을 견디는지. McpLocal의 `timeout`은 도구 목록 조회 타임아웃이다.
- **도구 이름 변환** (agent.tools는 Claude 이름이다):

  | Claude | OpenCode |
  |---|---|
  | Bash | bash |
  | Read | read |
  | Edit | edit |
  | Write | write |
  | Glob | glob |
  | Grep | grep |
  | WebFetch | webfetch |
  | WebSearch | websearch |
  | Task | task |
  | TodoWrite | todowrite |

  MCP 도구는 항상 허용한다.

### 2.8 G0 실측 결과 (2026-10-13, 서버의 `node:22-bookworm-slim` 일회용 컨테이너, opencode-ai **1.19.0**, 무료 모델 `opencode/big-pickle`)
실측 스크립트와 출력은 작업 폴더 `.context/g0/`(저장소 밖)에 있다. 아래가 G2 설계의 근거다.

| 항목 | 결과 |
|---|---|
| 설치 | `npm i -g opencode-ai@1.17.13`·`@1.19.0` 모두 성공(서버 CPU avx2, x86_64). 실행 옵션은 두 버전이 같다. **1.19.0으로 고정**(§9 Q7) |
| 자동 업데이트 끄기 | 환경변수 `OPENCODE_DISABLE_AUTOUPDATE` 존재 |
| 표준입력 | `opencode run`은 표준입력을 메시지로 읽는다 → 반드시 stdin을 닫는다(런타임은 이미 `stdin.end()`) |
| 이벤트 형식 | 한 줄에 `{type, timestamp, sessionID, part}`. `type`은 `step_start`·`text`·`tool_use`·`step_finish`·`error`. 텍스트는 `part.text`, 도구는 `part.tool`·`part.callID`·`part.state.{status, input, output \| error, metadata, time}`, 단계 종료는 `part.reason`·`part.tokens{total,input,output,reasoning,cache{read,write}}`·`part.cost`. **지금 정규화 코드는 평평한 형태만 읽는다 → G2-01 필수** |
| 오류 형식 | 맨 위 `error`: `{name:"APIError", data:{message, statusCode, isRetryable, responseHeaders, responseBody}}`(잘못된 키 401, 무료 등급 거절 403), `{name:"UnknownError", data:{message, ref}}`(없는 모델·로그인 안 된 유료 모델), `{_tag:"BadRequest"}`(이름·메시지 없음). 종료 코드 1, stderr는 비어 있음 |
| 로그인 없이 | 무료 모델 11개가 `opencode models`에 나오고 실행된다. 유료 모델은 로그인 전에는 목록에 없다. 코드의 무료 모델 목록은 실제와 달랐다(11개 중 1개만 일치) → 설치된 CLI의 목록을 기준으로 삼도록 변경(G1-11) |
| agent 지시문 주입 | `OPENCODE_CONFIG_CONTENT='{"agent":{"<name>":{"mode":"primary","prompt":"…"}}}'` + `--agent <name>` → 지시문 적용, 기본 도구(read 등) 유지, 작업 폴더·플랫폼 같은 기본 환경 정보도 유지(덧붙는 방식) |
| MCP 주입 | 같은 환경변수의 `mcp.<server> = {type:"local", command:[…], environment:{…}, enabled:true}` → 도구가 **`<server>_<tool>`**(`aidev-tools_echo_token`)로 노출. `--auto` 없이도, `--agent plan`에서도 호출됨. MCP 프로세스의 cwd = `--dir`, `environment`가 전달됨 |
| MCP 호출 타임아웃 | 기본 60초("MCP error -32001: Request timed out"). 서버 설정에 `"timeout": 2700000`을 주면 150초 호출이 끝까지 성공 → aidev-tools에는 45분을 준다 |
| 최대 단계 | `agent.<name>.steps`(1.19; 예전 이름 `maxSteps`) 동작 — 한도에 닿으면 모델에 중단 지시가 들어간다 |
| 세션 재개 | `--session <id>`로 이전 대화를 이어 간다 |
| **미확정(유료 로그인 후 재확인)** | ① 도구 제한(`agent.tools`·`agent.permission`): 무료 등급이 403("free tier can only be used from within OpenCode")으로 거절해 판단 불가 ② 이미지 첨부 `-f`: 메시지를 `-f` 앞에 둬야 함(뒤에 두면 메시지를 파일로 읽음), 무료 모델은 BadRequest ③ 사용량 한도(429) 오류의 실제 문구 ④ OpenCode Go 모델 목록 |

---

## 3. 명세

### 3.1 데이터 모델 (게이트웨이 SQLite, `store-aidev.ts` `migrateAidev`)
기존 패턴을 따른다: `addColumn`(`:51-54`), `CREATE TABLE IF NOT EXISTS`, 1회성 마이그레이션은 app_kv 마커.
```sql
-- G5-01: 모델 카탈로그 (전역)
CREATE TABLE IF NOT EXISTS engine_models (
  engine TEXT NOT NULL, model TEXT NOT NULL, label TEXT,
  level INTEGER,                 -- 0~4, NULL = 미측정(라우팅은 2로 취급)
  efforts TEXT,                  -- JSON 배열(약→강), NULL = 런타임 카탈로그의 effort.values / [] = 강도 없음(기본 한 칸)
  source TEXT NOT NULL DEFAULT 'seed',   -- seed | runtime | admin
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER,
  PRIMARY KEY (engine, model));
-- 시드: TIER_TABLE의 모델(claude/codex), INSERT OR IGNORE(관리자 수정 보존)

-- G5-01: 계정 정책 (JSON, 키 = 엔진)
ALTER TABLE accounts ADD COLUMN model_ceiling TEXT;        -- {"claude":"opus","opencode":"opencode-go/glm-5.3"}
ALTER TABLE accounts ADD COLUMN effort_floor TEXT;         -- 강도 하한: {"claude":"medium","codex":"low"}
ALTER TABLE accounts ADD COLUMN model_ladder TEXT;         -- 모델 사다리(우선순위): {"claude":["sonnet","opus","best"], ...} 약→강
ALTER TABLE accounts ADD COLUMN verify_priority TEXT;      -- ["codex","claude","opencode"] | NULL(= 지금의 교차 검증)
-- G5-01: 지능 점수 (전역, (모델, 강도) 조합마다)
CREATE TABLE IF NOT EXISTS model_scores (           -- (구현) 지수별 열, 추정값은 저장하지 않고 읽을 때 계산
  engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT '',   -- '' = 강도 없는 모델
  aa_ref TEXT,                   -- Artificial Analysis 항목 id(우선) 또는 slug — 관리자 매핑
  coding REAL, intelligence REAL, agentic REAL,     -- 0~100, NULL = 점수 없음
  source TEXT NOT NULL DEFAULT 'aa',                -- aa | admin (admin은 동기화가 덮어쓰지 않음)
  index_version TEXT,            -- 동기화 때의 intelligence_index_version — app_kv aa.index_version과 다르면 분할에 안 씀
  fetched_at INTEGER, updated_at INTEGER,
  PRIMARY KEY (engine, model, effort));
-- app_kv: 'aa.api_key'(관리자가 stdin으로 설정, 응답에 노출 금지), 'aa.synced_at', 'aa.index_version'
ALTER TABLE accounts ADD COLUMN score_index TEXT;          -- coding(NULL = 기본) | intelligence | agentic

-- 작업 우선순위 = 기존 accounts.engine_priority(목록에 없는 공급자는 작업에 쓰지 않음)
-- 하한 = 기존 accounts.model_floor, 강도 상한 = 기존 accounts.effort_cap
-- 공급자 선호 점수(가중치 슬라이더)·검증 "다른 공급자 우선" 토글은 두지 않는다(Q1: 순서만 따른다)

-- (§9 Q6을 채팅별로 결정하면) session_settings에 model_ceiling, model_ladder 추가
-- 주의: session_settings 정리 DELETE 조건(store-aidev.ts:327, :344, :377, :409)에 새 컬럼을 넣는다.
--       빠뜨리면 다른 설정 하나를 지울 때 새 설정이 담긴 행까지 삭제된다.

-- G3-04: engine_weights 시드를 엔진별 INSERT OR IGNORE로 (지금은 테이블이 비었을 때만 시드 → 기존 DB에 opencode 행이 생기지 않음)
```

### 3.2 게이트웨이 API (`/api/aidev/*`)
| 메서드 | 경로 | 변경 |
|---|---|---|
| GET | `/engines` | 응답에 다음을 추가한다(모든 맵은 `ENGINES`로 생성하고 키 리터럴은 쓰지 않는다): `models: {engine: [{value,label,level,efforts,routable}]}`, `model_ceiling`, `model_ladder`, `verify_priority`, **`preview: {engine: [D0..D4 → {model, effort, q2}]}`**(§2.3 계산 결과, 설정 화면 미리보기용) |
| PUT | `/settings/model-ceiling` | `{engine: model \| null}`. 사다리에서 하한보다 아래면 400 |
| PUT | `/settings/score-index` | `{index: 'coding' \| 'intelligence' \| 'agentic' \| null}` (null = 기본 coding) |
| PUT | `/settings/effort-floor` | `{engine: effort \| null}`. 강도 상한보다 위면 400(공통 순서 `none < minimal < low < medium < high < xhigh < max < ultra`) |
| PUT | `/settings/model-ladder` | `{engine: string[] \| null}`. 카탈로그에 없는 모델은 400. 하한·상한이 사다리에 없으면 400 |
| PUT | `/settings/verify-priority` | `{order: Engine[] \| null}` |
| PUT | `/settings/engine-priority` | 기존. 의미가 "작업 우선순위(목록에 없는 공급자는 작업에 쓰지 않음)"로 바뀐다. 빈 배열은 400 |
| PUT | `/settings/model-floor`, `/settings/effort-cap`, `/session-settings/:sid/*` | 입력 파싱을 `{claude, codex}` 하드코딩(`aidev-api.ts:382-383`, `:422`, `:436`, `:607`, `:613`)에서 `ENGINES` 순회로. 상한보다 위인 하한은 400 |
| PUT | `/engine-models` (관리자) | `{engine, model, level?, efforts?, enabled?}` |
| GET / PUT | `/model-scores` (GET 전 사용자, PUT 관리자) | GET: `{index, index_version, synced_at, rows:[{engine, model, effort, score, source}]}` + 출처 표기 문자열. PUT: `{engine, model, effort, score?, aa_slug?}` |
| POST | `/model-scores/sync` (관리자) | AA 무료 API에서 즉시 다시 가져오기(평소는 하루 1회 자동) |
| POST | `/route` | 입력은 그대로. 응답 `engines`를 `ENGINES`로 생성(`routing.ts:933`). `plan.reason`에 공급자 평가 사유(한도로 건너뜀, 실행 불가로 건너뜀, Q2 적용). 화면에 따로 알리지는 않는다(§9 Q12). `plan.step: {index, total, q2}` 추가 |
| PATCH | `/runs/:id/outcome` | 응답 `next`에 `from_engine` 추가 |
| (런타임) POST | `/api/aidev-tools/verify` | 입력에 `candidates: [{engine, model, effort}]`. 없으면 지금 방식(하위 호환, 한 릴리스 동안) |
| (런타임) POST | `/api/aidev-tools/curate` | 입력에 `candidates` |

`manage-users`(`deploy/aidev/auth-gateway/src/manage-users.ts:17`)에 `model-ceiling`, `effort-floor`, `model-ladder`, `verify-priority`, `engine-model`, `model-score`, `aa-key`(stdin) 명령을 추가한다.
agent 도구 `nadovibe_settings`(`server/modules/aidev-tools/app-control.service.ts:68-70`, `:106-119`, 설명 `aidev-tools-mcp.ts:135`)에는 `model_ceiling.<e>`, `effort_floor.<e>`, `model_ladder.<e>`, `verify_priority` 키를 추가한다.

### 3.3 런타임 (server/)
- `sanitizeAidevOptions` 엔진 화이트리스트(`aidev-tools.service.ts:323`)와 `AidevTurnOptions.engine`(`:257`)에 opencode를 넣는다.
- aidev-tools 라우트의 엔진 필터를 고친다.
  - 위치: `aidev-tools.routes.ts:31`, `:65-66`, `:87-92`, `:116`, `:144`
  - opencode를 받는다. 필터 결과가 **빈 배열이면 "쓸 수 있는 엔진 없음"으로 실패**하게 한다. 지금은 빈 배열을 "전부 허용"으로 해석해 Claude를 실행한다(`specialist-judge.service.ts:305`, `lesson-curator.service.ts:115`).
- OpenCode 부가 턴 공통 함수 `askOpenCode(prompt, {model, variant, readOnly, timeoutMs})`
  - 임시 작업 폴더에서 `opencode run --format json`을 실행한다.
  - 세션 동기화기(`opencode-session-synchronizer.provider.ts:93-94`)가 임시 폴더 세션을 제외하게 해서 사용자 대화 목록에 섞이지 않게 한다.
- 사용량 한도
  - 감지: G0-06 실측으로 정한다. 후보는 error 이벤트의 `name=APIError`·`statusCode=429` 또는 메시지 정규식이다.
  - 감지하면 `providerUsageLimitsService.recordBlock('opencode', …)`, complete에 `usageLimit`을 싣는다.
  - `USAGE_ENGINES`(`provider-usage-limits.service.ts:32`)에 opencode를 추가한다.
- 인증 실패: 감지하면 auth status에 반영한다(Codex `noteCodexTurnError` 방식, `server/shared/utils.ts:85-107`).

### 3.4 프런트 (src/, src-mobile/)
- 공통 정의 (frontend-module-standards: 2개 이상 모듈이 쓰므로 shared에 둔다)
  - `src/shared/types.ts`: `export type AidevEngine = Exclude<LLMProvider, 'cursor'>;`
  - `src/shared/constants.ts`: `AIDEV_ENGINES: readonly AidevEngine[] = ['claude','codex','opencode']`, `ENGINE_LABELS: Record<AidevEngine,string>`
  - `src/shared/utils.ts`: `isAidevEngine(value)`
  - 위 정의 하나로 **Cursor 숨김**과 **엔진 목록**을 함께 해결한다. 숨길 집합(cursor 제외)과 aidev 엔진 집합이 같기 때문이다.
- `ENGINE_LABEL` 중복 네 곳(`useEscalation.ts:32`, `useReturnFromHandoff.ts:15`, `UsageLimitPanel.tsx:5`, `ChatInterface.tsx:495`)을 `ENGINE_LABELS`로 합친다.
- 설정 UI 배치
  - 작업대: 설정 → **Agents 탭 상단 블록**(`AgentsSettingsTab.tsx:87`, 지금 `EnginePriorityDefaults`와 `EffortCapDefaults`가 있는 곳)에 둔다. 블록이 커지므로 "라우팅" 카테고리로 분리한다(§9 Q9).
    - (2026-10-13 사용자 요청) 공급자 카드는 상단이 아니라 **아래 공급자별 설정의 「모델·강도 범위」 탭**에 둔다. 상단에는 점수 지수·작업 순서·검증 순서만.
    - **점수 지수**: Coding(기본) / Intelligence / Agentic 선택. 바꾸면 미리보기가 그 지수로 다시 계산된다
    - **작업 우선순위**: 공급자 순서 편집(체크 해제 = 작업에 쓰지 않음)과 '자동(학습 점수)'. 문구: "한도에 걸렸을 때만 다음 순위로 넘어갑니다"
    - **검증 우선순위**: 공급자 순서 편집, '자동(작업자와 다른 공급자 우선)'
    - **공급자 카드** ×3:
      - 모델 사다리(드래그로 약→강 순서, 체크 해제 = 쓰지 않음)
      - 하한·상한 선택(사다리 안에서)
      - **모델 하한·상한**(사다리 안에서 선택)
      - **강도 하한·상한**(기존 `EffortCapDefaults`의 상한을 카드 안으로 옮기고 하한을 추가)
      - 조합별 지능 점수 표(출처 AA/관리자/추정 표시, 아래에 "점수: Artificial Analysis" 링크 — 출처 표기 의무)
      - **D0~D4 미리보기**: 서버 `preview`를 그대로 표시한다(예: "D2 → opus · medium", Q2 적용 칸은 "상한·최대" 표시). 계산은 서버 한 곳에서만 한다
      - 하한·상한을 비우면 "등급표(기본)"로 표시한다
    - 섹션 스타일은 기존 `rounded-lg border border-border p-3 text-sm`
  - 모바일: `src-mobile/screens/SettingsScreen.tsx:72-139`의 엔진 우선순위 섹션 아래에 같은 항목을 시트로 둔다.
- API 정의는 지금처럼 `src/modules/aidev-router/api.ts`에 둔다. 표준(`src/shared/api.ts`)과는 어긋나지만 기존 위치를 따른다. 옮기는 일은 별도 항목이다.

---

## 4. 계획표

| 단계 | 목표 | 주 산출물 | 의존 | 배포 단위 | 규모 |
|---|---|---|---|---|---|
| **G0 사전 검증** | opencode CLI 실제 동작을 확정한다(추측 설계 금지) | 버전 고정값, 이벤트 샘플, 주입 방식 확인 기록(§3.3 갱신) | — | 없음(서버 컨테이너에서 실측) | S |
| **G1 기반** | 서버에서 OpenCode를 **일반 채팅으로** 쓸 수 있게 한다. Cursor 숨김. 기존 버그 수정 | 런타임 이미지, 공통 엔진 상수, 숨김, 버그 4건, 임시 라우팅 우회 | G0-01·02 | 릴리스 ① + 이미지 재빌드 | S~M |
| **G2 런타임 동등화** | OpenCode 채팅이 전문 agent, aidev-tools, 한도·인증 감지, 부가 턴까지 Claude·Codex와 같이 동작한다 | `buildOpenCodeAidevConfig`, 이벤트 정규화, 한도·인증·토큰·중단, 부가 턴 | G0, G1 | 릴리스 ② | L |
| **G3 게이트웨이 3엔진** | 라우터가 opencode를 엔진으로 고른다(알고리즘은 지금과 같은 형태, N개 엔진) | 리터럴 제거, 이분법 제거, opencode 등급 열, 가중치 시드 | G2 | 릴리스 ③ (G4와 함께) | M~L |
| **G4 프런트 3엔진** | 작업대·모바일이 3엔진을 표시·선택·인계한다 | Engine 타입, 라우터 바, 패널, 컴포저 다른 엔진 그룹, 모바일 | G3 API | 릴리스 ③ | M |
| **G5 공급자 정책** | 작업·검증 우선순위(한도일 때만 다음), 하한~상한 (모델, 강도) 균등분할, Q2 상한·최대로 유동 선택한다 | `engine_models`, 계정 정책, `pickProvider`/`pickStep`, 검증 후보 이동, 설정 UI·미리보기 | G3, G4 | 릴리스 ④(게이트웨이+런타임) → ⑤(UI) | L |
| **G6 검증·문서** | 서버 확인, 회귀 관문, 문서 갱신 | verify-b 항목, 측정, IMPLEMENTATION-PLAN 갱신 | 각 단계 | 매 릴리스 | S |

**순서 근거**
- G1을 먼저 배포해 OpenCode Go 로그인과 기본 채팅을 실사용으로 확인한다. G2의 이벤트·한도 실측도 서버에서만 정확하다.
- G3와 G4는 응답 형태(`engines` 맵, `NextAction.from_engine`)를 함께 바꾸므로 한 릴리스로 묶는다.
- G5는 동등성 테스트를 통과한 게이트웨이를 먼저 배포하고(정책을 정하지 않은 항목은 지금 동작 그대로, §9 Q11), UI를 다음에 낸다.

---

## 5. 체크리스트

표기: `[ ]` 미착수 / `[~]` 진행(구현·로컬검증) / `[x]` 서버 확인(릴리스 ID)

### GP. 정책 구조 먼저 — Claude·Codex (2026-10-13 사용자 결정: "claude와 codex를 지금 얘기한 구조로 먼저 맞추고 opencode는 거기에 맞춰서")
G5의 정책 구조를 OpenCode 없이 두 엔진으로 먼저 구현했다. OpenCode는 G0~G4에서 이 구조에 엔진 하나를 더하는 일이 된다.
- [~] 구현·로컬검증 완료, 서버 확인 대기 — GP-01 게이트웨이 `provider-policy.ts`(새 모듈): 카탈로그(`MODEL_CATALOG`, 모델별 level·강도), 공통 강도 순서, `policySteps`·`pickStep`(점수 분할 → 칸 수 분할 대체, Q2)·`previewPolicy`·`estimateScores`(보간·평균 차이 추정). = G5-03·G5-04의 핵심
- [~] GP-02 저장소 `store-aidev.ts`: `accounts.model_ceiling/effort_floor/model_ladder/verify_priority/score_index`, `model_scores` 표, `providerPolicy`(채팅 하한 > 계정 상한이면 상한을 올림), 범위 한꺼번에 검사하는 `setProviderPolicy`, 기존 `setModelFloor`·`setEffortCap`에도 상한·하한 교차 검사. = G5-01·G5-02b
- [~] GP-03 라우팅 `routing.ts`: 사다리가 있는 공급자는 `splitTier`로 고름(tier_policy 미적용, agent 모델은 범위 안·더 강할 때만), 응답 `plan.step`, 결정 기록에 `step`·공급자별 평가. 엔진 목록 리터럴 제거(점수·usable·응답 `engines`·동점 처리). 채팅에 묶인 엔진이 한도면 다음 공급자로 `switch_back`(고정 채팅 제외). = G1-08·G5-03·G5-13, G3-03 일부
- [~] GP-04 `escalation.ts`: 작업 순서가 있으면 공급자 전환은 한도·로그인 만료일 때만(Q1), 범위 최상단 실패는 `ask_user`; 분할 모드의 `escalate_tier`는 같은 공급자의 다음 칸; `NextAction.from_engine`; 다음 공급자 = 순서상 다음 usable(한도 제외). = G3-06·G5-08
- [~] GP-05 검증 후보를 게이트웨이가 계산(`aidev-api.ts verifyCandidates`, 검증 순서 또는 사다리가 있을 때만 — 없으면 지금처럼 런타임이 정함), 런타임 `run-verifier.service.ts verifierCandidates`가 순서대로 시도(모델·강도 적용, Codex 로그아웃·과부하 규칙 유지). = G5-06
- [~] GP-06 부가 턴: agent 설계(작업 순서만, `splitTier(3)`), 지식 점검(작업 순서, `splitTier(1)`, 한도 제외). 교훈 정제(curate)도 작업 순서가 있으면 게이트웨이가 후보(`candidates`, 한도 제외, 정책의 D0 모델)를 보내고 런타임 `curatorOrder`가 순서대로 시도
- [~] GP-07 점수 동기화 `model-scores.ts`(하루 1회, 키 없으면 아무 일 없음, 한 번에 기록, admin 값 보존, 실패 시 유지), 게이트웨이 시작 시 예약. API `GET/PUT /model-scores`·`POST /model-scores/sync`(관리자). = G5-02a. **남은 것: AA 키 설치와 우리 조합의 매핑(G0-09)** — 그 전까지는 칸 수 분할
- [~] GP-08 API `GET/PUT /settings/provider-policy`, `PUT /settings/verify-priority`, `PUT /settings/score-index`, `GET /engines`의 `policy`; 입력 파싱의 `{claude, codex}` 하드코딩 제거. CLI `manage-users model-ceiling|effort-floor|model-ladder|verify-priority|score-index|aa-key|model-scores|model-score`, agent 도구 `nadovibe_settings`의 `model_ceiling.<e>`·`effort_floor.<e>`·`model_ladder.<e>`·`verify_priority`·`score_index`. = G5-09
- [~] GP-09 작업대 설정 → Agents: 상단 `ProviderPolicySettings`에는 공급자 전체에 걸친 것만(작업·검증 순서, 점수 지수와 출처), 각 공급자의 범위는 아래 공급자별 설정의 「모델·강도 범위」 탭 `ProviderPolicyCard`(사다리·모델 하한/상한·강도 하한/상한·D0~D4 미리보기·조합별 점수 — 2026-10-13 사용자 요청 "모델 상한 하한 설정은 하단 프로바이더별 설정 안으로"). 탭은 정책이 있는 공급자(`isPolicyProvider`: claude·codex, OpenCode는 G3에서)에만. 이전의 `EnginePriorityDefaults`·`EffortCapDefaults`·`useEnginePriority`는 대체·삭제. 모바일 설정 `ProviderPolicySection`(같은 훅), 계정 단위 `EffortCapControl` 대체(채팅 단위는 유지). = G5-10·G5-11
- [~] GP-10 라우터 바·모바일 라우팅 시트에 선택 사유 한 줄(`policyNote`: "Claude 한도 → Codex · 범위 5/8 · 상한·최대") = G5-12
- 검증(로컬, 2026-10-13): 게이트웨이 테스트 30개(새 `provider-policy-test.mjs`: 예시 1·2 표, Q1·Q2, 범위 검사, 라우팅·에스컬레이션·검증 후보·설정 API·AA 동기화), 서버 555(실패 0), 클라이언트 638(새 `providerPolicySettings.test.tsx`), typecheck·lint 오류 0. 로컬 플랫폼에서 작업대·모바일 설정 화면을 열어 하한 sonnet·상한 opus → D0~D4가 예시 2와 같게 표시·라우팅됨을 확인.

### G0. 사전 검증 (서버 런타임과 같은 환경에서 실측, 코드 변경 없음)
- [x] 확인(1.19.0 고정, `OPENCODE_DISABLE_AUTOUPDATE`) — §2.8 — G0-01 **버전 고정**
  - `node:22-bookworm-slim`에서 `npm i -g opencode-ai@<v>`를 설치하고 `opencode --version`을 확인한다.
  - 후보: 코드가 검증한 **1.17.13**(`opencode-runtime.provider.js:24`)과 최신(1.19.0, 2026-10-13).
  - postinstall이 서버 CPU에 맞는 바이너리(avx2 / baseline)를 고르는지 확인한다.
  - 자동 업데이트를 끄는 환경변수 이름(`OPENCODE_DISABLE_AUTOUPDATE` 등)도 확인한다.
  - 결과: §9 Q7 확정.
- [~] 무료 모델·로그인 없는 상태까지 확인. Go 로그인과 Go 모델 목록은 사용자 로그인 뒤 — G0-02 **OpenCode Go 로그인 실측**
  - 런타임 컨테이너 셸에서 `opencode auth login`을 실행해 Go를 고르면 `~/.local/share/opencode/auth.json`에 `opencode-go` 키가 생기는지 확인한다.
  - 작업대 설정 → Agents → OpenCode 로그인(`ProviderLoginModal.tsx:62-63`, 셸 `opencode auth login`)이 컨테이너 터미널에서 끝까지 되는지 확인한다.
  - `opencode models opencode-go` 출력을 저장하고 카탈로그(`opencode-models.provider.ts:84-260`)와 대조한다. 모델 id 불일치는 G1-11에서 고친다.
- [x] 확인 — §2.8 — G0-03 **`run --format json` 이벤트 형식**
  - text, reasoning, tool_use, step_start/finish, error 샘플을 저장한다.
  - 로컬 1.0.223은 `{type, timestamp, sessionID, part}`로 감싼 형태이고, `normalizeMessage`(`opencode-sessions.provider.ts:205-302`)는 평평한 형태만 읽는다. 대상 버전에서 어느 쪽인지 확인한다.
  - 샘플은 `server/modules/providers/list/opencode/` 테스트 픽스처로 쓴다.
- [x] 확인(지시문은 덧붙는 방식, plan과 함께 쓰는 법은 G2-02에서) — §2.8 — G0-04 **실행별 설정 주입**
  - `OPENCODE_CONFIG_CONTENT`의 `agent.<name>.prompt`가 기본 시스템 프롬프트를 대체하는지 덧붙이는지 확인한다.
  - `--agent <name>`과 결합되는지, `--agent plan`과 함께 쓸 수 있는지 확인한다.
  - `instructions` 대안의 동작도 확인한다.
- [x] 확인(도구 이름 `<server>_<tool>`, 승인 불필요, timeout 설정, cwd) — §2.8 — G0-05 **MCP 주입**
  - local MCP 도구가 노출되는 이름(`<server>_<tool>` 형식 등)을 확인한다.
  - 승인 없이 호출되는지(권한 키) 확인한다.
  - 호출 타임아웃: remote_exec가 45분 대기(`aidev-tools-mcp.ts:63-64`) 가능한지 확인한다.
  - MCP 자식 프로세스의 cwd가 `--dir`인지 확인한다(`remote_sync` 기본 원본, `aidev-tools-mcp.ts:59-60`).
- [~] 401·403·모델 없음 형태 확인. 429(한도) 문구는 실제 발생 시 — G0-06 **한도·인증 오류 형태**
  - 잘못된 키(401)와 한도 초과(429, 재현 가능하면) 때 error 이벤트와 stderr 형태를 확인하고, 감지 정규식 초안을 만든다.
  - Go 요금제의 한도 창(5시간·주간 등)과 재설정 시각을 얻는 방법이 있는지 조사한다.
- [~] `-f`는 메시지 뒤에 둬야 함 확인. 모델이 이미지를 보는지는 유료 모델로 — G0-07 **이미지 첨부**: `-f/--file`로 이미지를 넘기면 모델이 보는지 확인한다. 지금은 경로 태그만 붙인다(`opencode-runtime.provider.js:275-287`).
- [x] §2.8에 기록 — G0-08 결과를 §2.7·§3.3에 반영하고, 설계 변경이 생기면 이 문서를 먼저 고친다.
- [ ] G0-09 **지능 점수 출처 확인** (Artificial Analysis)
  - 무료 API 키를 발급한다(사용자가 직접 발급·설치, 원칙 10).
  - `GET /api/v2/language/models/free` 응답 필드를 확인한다: 지수 값, 지수 버전, 항목 slug, 강도 변형 표기.
  - **우리 조합의 매핑표 초안**을 만든다. 대상: claude haiku·sonnet·opus·best(현재 별칭이 가리키는 실제 모델) × 강도, codex luna·terra·sol·astra × 강도, OpenCode Go 모델(G0-02 목록) × 강도. 각 조합의 점수 유무(빈칸 비율)를 기록한다.
  - 약관(Data Platform Terms)상 서버 내부 라우팅에 쓰고 화면에 출처를 표기하는 용도가 허용되는지 확인한다.
  - 결과: §9 Q13~Q15 확정, 빈칸이 많으면 추정 규칙(Q14)을 보강한다.

### G1. 기반 (릴리스 ① + 런타임 이미지 재빌드)
- [~] 구현·로컬검증(`Dockerfile`에 `OPENCODE_VERSION`·전역 설치·`OPENCODE_DISABLE_AUTOUPDATE=1`), 서버 확인 대기 — G1-01 런타임 이미지에 opencode를 설치한다. `deploy/aidev/runtime/Dockerfile`
  - `ARG OPENCODE_VERSION`, `test -n` 검사를 추가한다.
  - `npm install -g @anthropic-ai/claude-code@… opencode-ai@${OPENCODE_VERSION}`로 설치한다(global이라 postinstall이 실행됨).
  - 자동 업데이트 끄기 환경변수를 `ENV`에 넣는다(G0-01).
  - 상단 주석 "Rebuild only when a tool version changes"에 OpenCode를 추가한다.
- [~] 구현·로컬검증(`runtime-image.sh` build-arg, `.env.example` `OPENCODE_VERSION=1.19.0`), 서버 확인 대기 — G1-02 빌드 인자를 넘긴다.
  - `deploy/aidev/release/runtime-image.sh:16-20`에 `--build-arg OPENCODE_VERSION="${OPENCODE_VERSION:?}"`
  - `deploy/aidev/.env.example`에 `OPENCODE_VERSION=<G0-01>`
  - 서버 `~/aidev/deploy/.env`에도 같은 값을 넣는다(배포 시 G6-03).
- [~] 구현·로컬검증(`AidevEngine`·`AIDEV_ENGINES`·`ENGINE_LABELS`·`isAidevEngine`), 서버 확인 대기 — G1-03 공통 엔진 정의(§3.4): `src/shared/types.ts` `AidevEngine`, `src/shared/constants.ts` `AIDEV_ENGINES`·`ENGINE_LABELS`, `src/shared/utils.ts` `isAidevEngine`. 각 정의에 주석과 그룹 헤더를 단다(표준).
- [~] 구현·로컬검증(목록 6곳 + 저장값 읽기·쓰기(Cursor는 기억하지 않음), 테스트 3개 갱신), 서버 확인 대기 — G1-04 **Cursor 숨김** (사용자에게 보이는 목록만, 타입·라벨 매핑은 유지)
  - `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx:29-34` `PROVIDER_META`를 `AIDEV_ENGINES`로 필터
  - `src/modules/chat/modals/ModelLibraryPanel.tsx:22-27` `PROVIDERS` 필터
  - `src/modules/settings/tabs/agents-settings/AgentsSettingsTab.tsx:45-47` `visibleAgents` → `AIDEV_ENGINES`
  - `src/modules/onboarding/AgentConnectionsStep.tsx:19-25` 로그인 카드 필터
  - `src/modules/provider-auth/hooks/useProviderAuthStatus.ts:7` 기본 갱신 목록(cursor 인증 조회 중단)
  - `src/shared/selectedProvider.ts:19` 저장값 검증을 `AIDEV_ENGINES`로 한다. 저장된 `'cursor'`이면 claude로 돌아간다.
  - 옛 cursor 세션을 열 때 `writeSelectedProvider('cursor')`(`useChatProviderState.ts:433-440`)를 쓰지 않게 하고, 다른 reader(`git-panel useSelectedProvider.ts:12`)의 동작을 확인한다.
  - 테스트 갱신: `src/modules/chat/tests/chatProviderModels.test.ts:139-145`, `src/modules/git-panel/tests/selectedProviderSync.test.tsx:49-52`, `:90`
  - 완료 조건: 설정 Agents의 provider 칩, 빈 채팅 모델 선택기, 모델 라이브러리, 온보딩에 Cursor가 없다. 옛 cursor 세션은 사이드바와 대화에서 그대로 열린다.
- [~] 구현·로컬검증(빈 화면이던 OpenCode의 권한 탭을 숨김(Account·MCP만). 권한 설정 UI 자체는 G4에서 엔진 UI와 함께), 서버 확인 대기 — G1-05 OpenCode 설정의 빈 권한 화면을 고친다.
  - Agents → OpenCode → 권한 카테고리가 빈 화면이다(`AgentCategoryContentSection.tsx:44-90`, `PermissionsContent.tsx:604`).
  - 새 채팅 기본 권한 모드(`opencodePermissions.defaultPermissionMode`, `src/shared/userSettings.ts:166-173`가 이미 읽음)를 고르는 내용을 넣는다.
- [~] 구현·로컬검증(`ChatInterface`는 라우팅 대상(claude·codex)일 때만 라우터의 모델 고정을 쓰고, 모바일은 세션의 provider를 그대로 씀), 서버 확인 대기 — G1-06 **기존 버그**: opencode 세션을 claude로 바꾸는 곳 3곳
  - `src/modules/chat/ChatInterface.tsx:486` `composerEngine = provider === 'codex' ? 'codex' : 'claude'`: opencode 채팅에서 모델을 고르면 `engine:'claude'`로 고정된다(`:507`). → `isAidevEngine(provider) ? provider : 'claude'`
  - `src-mobile/screens/ChatScreen.tsx:50` `readProvider`, `:152` `resolvedProvider`: opencode와 cursor 세션이 모바일에서 claude로 취급된다. → 세션 provider를 그대로 쓴다.
- [~] 구현·로컬검증(런타임 라우트 `sideEngines`: 목록이 왔는데 쓸 엔진이 없으면 409(판정·교훈), 설계·지식 점검은 모르는 엔진이면 400), 서버 확인 대기 — G1-07 **기존 버그**: 허용 엔진 필터가 빈 배열이 되면 전체 허용으로 바뀐다(D-05 위반)
  - `server/modules/aidev-tools/aidev-tools.routes.ts:31`(judge), `:66`(curate), `:89`(verify 기본 `['claude','codex']`)
  - `specialist-judge.service.ts:305` `!input.engines?.length`이면 전부 → 빈 배열은 "엔진 없음" 오류로 처리한다.
  - `lesson-curator.service.ts:115`, `:123`도 같다.
  - `:116`(design), `:144`(knowledge)의 `engine === 'codex' ? 'codex' : 'claude'`: G2에서 opencode를 지원하기 전까지 opencode면 400을 낸다.
- [~] 구현·로컬검증(GP-03에서 구현(고정 채팅 제외), 로컬검증), 서버 확인 대기 — G1-08 **기존 버그**: 채팅에 묶인 엔진이 사용량 한도에 걸려도 그 엔진이 선택된다(`routing.ts:750`). limited면 `switch_back`처럼 다음 usable 엔진을 제안한다(사유 기록).
- [~] 구현·로컬검증(`useAidevRouting.beforeSend`가 엔진이 아닌 provider면 null), 서버 확인 대기 — G1-09 **임시 우회**: G3 전까지 라우터가 opencode 채팅을 가로채지 않게 한다.
  - `src/modules/aidev-router/hooks/useAidevRouting.ts:118` `beforeSend`에서 `!asEngine(context.provider)`이면 `null`을 반환한다.
  - 지금은 새 채팅에서 opencode를 골라도 `useChatComposerState.ts:856-857`이 계획 엔진(claude·codex)으로 세션을 만든다. 기존 opencode 채팅의 run도 claude·codex 엔진으로 기록된다.
  - 모바일도 같은 훅을 쓰는지 확인한다.
  - G4-02에서 제거한다.
- [ ] G1-10 Gemini 경로: OpenCode Zen 로그인이면 코드 변경이 없다(`opencode/gemini-*`가 카탈로그에 있음). Google API 키를 쓰기로 하면(§9 Q8) G1-11에서 `google/…` 모델을 추가한다.
- [~] 구현·로컬검증(목록 정정 대신 **설치된 CLI의 `opencode models`를 기준**으로(10분 캐시, 로그인 변경 시 갱신): 카탈로그 항목은 이름·강도만 제공, 모르는 모델은 id로 표시, CLI가 없으면 기존 방식. Google 키 등 사용자가 연결한 공급자의 모델도 이것으로 보임), 서버 확인 대기 — G1-11 OpenCode 카탈로그 정정(`opencode-models.provider.ts`)
  - G0-02 실측 목록과 다른 Go 모델 id를 고친다.
  - (Q8 결정 시) `google/<id>` 항목을 추가하고, `OPENCODE_ENV_PROVIDER_IDS`(`:299-303`)에 `GOOGLE_GENERATIVE_AI_API_KEY: 'google'`을 추가한다.
  - 테스트 `server/modules/providers/tests/opencode-models.test.ts`
- [x] IMPLEMENTATION-PLAN §0 원칙 4에 반영 — G1-12 원칙 4(upstream 수정 최소화)의 허용 지점에 이번 단계에서 고치는 upstream 파일을 추가한다(§9 Q10). IMPLEMENTATION-PLAN §0을 갱신한다.
- [ ] G1-13 **서버 확인**
  - 이미지를 재빌드하고 런타임을 재생성한 뒤 `docker exec <runtime> opencode --version`을 확인한다.
  - 설정에 Cursor가 없다.
  - OpenCode Go에 로그인하고 GLM으로 새 채팅을 보내면 OpenCode 세션으로 생성되고 응답이 표시된다.
  - 옛 cursor 세션이 열린다.

### G2. OpenCode 런타임 동등화 (릴리스 ②)
로컬 e2e(2026-10-13, 로컬 플랫폼 + 실제 opencode 1.19.0 + 무료 모델 `opencode/big-pickle`, 웹소켓 `chat.send`): ① 일반 채팅(응답·토큰) ② 주입된 aidev-tools의 `nadovibe_settings` 호출(`aidev-tools_nadovibe_settings`, 게이트웨이 실제 응답) ③ 전문 agent 지시문 적용 + 기본 도구(read) + 실패한 도구 호출의 오류 표시 ④ `--session`으로 이어가기 — 모두 통과. 런타임 로그 `[OpenCode] aidev routing: agent=aidev-frontend-react mcp=aidev-tools …`.
- [~] 구현·로컬검증(`part` 기반으로 읽고 예전 평평한 형태도 유지, 오류는 `describeOpenCodeError`), 서버 확인 대기 — G2-01 **이벤트 정규화**: `opencode-sessions.provider.ts:205-302`를 G0-03 형식(`part` 기반) 기준으로 고친다.
  - text, reasoning, tool(입력·출력·상태), step, error(`{name, data:{message, statusCode}}`)를 모두 처리한다. 지금은 error가 "Unknown OpenCode error"로 표시된다.
  - 픽스처 교체: `opencode-runtime.provider.test.js:36-39`, `server/modules/providers/tests/opencode-sessions.test.ts:221-505`
- [~] 구현·로컬검증(`buildOpenCodeAidevConfig`(aidev-tools MCP 45분 타임아웃·agent MCP·`aidev-<name>` agent·`steps`) → `OPENCODE_CONFIG_CONTENT`·`--agent`. plan 모드는 OpenCode의 plan agent 유지(전문 agent 지시문 미적용), 도구 제한은 미적용 — 둘 다 유료 로그인 후 확인), 서버 확인 대기 — G2-02 **aidev 어댑터** `buildOpenCodeAidevConfig(options.aidev)`(§2.7)
  - `opencode-runtime.provider.js:250-298`의 args와 env에 `--agent`, `OPENCODE_CONFIG_CONTENT`를 넣는다.
  - aidev-tools MCP는 aidev가 null이어도 주입한다(`aidevToolsService.getMcpServerConfig`, `aidev-tools.service.ts:375-389`).
  - agent 전용 mcpServers를 병합한다(url은 remote, command는 local).
  - 지시문은 `composeAgentInstructions`(`:343-360`)로 만든다.
  - 도구 제한은 이름 변환 표(§2.7)를 따르고, MCP는 항상 허용한다.
  - maxTurns는 `maxSteps`로 넘긴다.
  - plan 모드와 aidev agent가 함께 오면 permission deny로 표현한다.
  - 로그는 `[OpenCode] aidev routing: agent=… run=…`(Claude `:267`, Codex `:317`와 같은 형식).
- [ ] G2-03 도구 이름 변환 함수(Claude→OpenCode)를 `aidev-tools.service.ts`에 두고 `index.ts`로 export한다(backend 표준 확인).
- [~] 구현·로컬검증(엔진 화이트리스트에 opencode), 서버 확인 대기 — G2-04 `sanitizeAidevOptions` 엔진 화이트리스트(`aidev-tools.service.ts:323`)와 `AidevTurnOptions.engine`(`:257`)에 opencode를 추가한다. 테스트 `aidev-tools/tests/aidev-tools.service.test.ts:21-62`
- [~] 구현·로컬검증(오류 이벤트가 한도(429·문구)면 complete에 `usageLimit{type:unknown}`, `recordBlock`/`recordClear`, `USAGE_ENGINES`에 opencode. 실제 한도 문구는 발생 시 보강), 서버 확인 대기 — G2-05 **사용량 한도**: 감지 규칙(G0-06)을 넣는다.
  - error 이벤트와 stderr에서 감지하면 `recordBlock('opencode')`, 성공 턴이면 `recordClear`, complete에 `usageLimit`을 싣는다(`opencode-runtime.provider.js:353`, `:396`).
  - `USAGE_ENGINES`에 opencode를 넣는다(`provider-usage-limits.service.ts:32`).
  - 테스트: `codex-usage-limit.test.ts`처럼 `opencode-usage-limit.test.ts`를 새로 만든다.
  - 완료 조건: OpenCode가 한도에 걸리면 프런트 E-03 인계 흐름(다음 공급자로)이 동작한다.
- [~] 구현·로컬검증(401·자격 문구 → `noteOpenCodeRunError` → auth status가 "sign-in rejected", 새 로그인(auth.json 갱신)·로그아웃 시 해제), 서버 확인 대기 — G2-06 **인증 실패**: 401이나 로그인 만료를 감지하면 `OpenCodeProviderAuth.getStatus`(`opencode-auth.provider.ts:42-54`)가 미인증을 돌려준다(Codex `currentCodexAuthFailure` 방식). 그러면 게이트웨이 가용성에서 빠진다.
- [ ] G2-07 **stderr 처리**: 지금은 stderr의 모든 덩어리를 error 프레임으로 보낸다(`:310-325`). 경고와 로그는 거르고 실제 오류만 보낸다(Codex Landlock 경고 숨김과 같은 방식).
- [~] 구현·로컬검증(런타임은 마지막 `step_finish`의 `part.tokens`를 컨텍스트로(없으면 DB). REST·기록 경로 통일은 남음), 서버 확인 대기 — G2-08 **토큰 사용량**을 통일한다.
  - 런타임 `readOpenCodeTokenUsage`(`:66-124`), REST(`provider-token-usage.service.ts:279-338`, `:396-406`), 기록(`opencode-sessions.provider.ts:156-199`)의 세 경로를 message.data 합산 기준으로 맞춘다.
  - `total`(모델 컨텍스트)을 추가한다. 테스트 `provider-token-usage.service.test.ts`
- [~] 구현·로컬검증(SIGTERM 후 종료까지 대기(10초 뒤 SIGKILL)), 서버 확인 대기 — G2-09 **중단**: SIGTERM 뒤 close까지 기다린다(Codex `ABORT_SETTLE_TIMEOUT_MS` 10초와 같음, `opencode-runtime.provider.js:405-417`). 끼어들기 직후 같은 세션 재개 경합을 막기 위해서다.
- [ ] G2-10 **이미지**: G0-07이 되면 `-f`로 첨부한다. 안 되면 경로 태그를 유지하고 사유를 기록한다.
- [~] 구현·로컬검증(`bash`, `filePath`), 서버 확인 대기 — G2-11 **브리프 도구 이름**: `handoff.service.ts:9-10`, `run-verifier.service.ts:101-102`의 `FILE_TOOLS/COMMAND_TOOLS`에 opencode 이름(`bash`, `edit`, `write`, `read`…)과 입력 키 `filePath`를 추가한다. 테스트 `handoff.test.ts`
- [ ] G2-12 **부가 턴 실행기** `askOpenCode` (§3.3)
  - 임시 폴더(`/tmp/aidev-side-<id>`), `--format json`, 결과 텍스트 추출, 타임아웃, read-only(plan 권한)를 지원한다.
  - 세션 동기화기(`opencode-session-synchronizer.provider.ts:93-94`)가 임시 폴더 세션을 제외하게 한다.
- [ ] G2-13 **부가 턴 opencode 지원**: 엔진 유니온과 분기를 확장한다.
  - `run-verifier.service.ts:25`, `:28`, `:34`, `:244`, `:253`
  - `lesson-curator.service.ts:18-20`, `:115-126`
  - `agent-designer.service.ts:26`, `:145`
  - `knowledge-check.service.ts:21`, `:122`
  - 라우트 `aidev-tools.routes.ts:65-66`, `:87-92`, `:116`, `:144`가 opencode를 받는다.
  - 판정(`specialist-judge.service.ts`)은 제외한다(§9 Q4).
  - 테스트: `run-verifier.test.ts:26-41`, `lesson-curator.test.ts`, `agent-designer.test.ts`, `knowledge-check.test.ts`
- [ ] G2-14 설정 키: `app-control.service.ts:68-70`, `:106-119`의 `effort_cap.*`·`model_floor.*`·`engine_priority`에 opencode를 넣는다. MCP 설명(`aidev-tools-mcp.ts:135`)도 고친다. 테스트 `app-control.test.ts:21`
- [ ] G2-15 (선택) `remote_agent`에 opencode를 추가한다: `local-agent.ts:10`, `:25-45`, `:77-159`, MCP enum `aidev-tools-mcp.ts:403`, `:421`, `aidev-tools-mcp.routes.ts:232`
- [ ] G2-16 **서버 확인** (opencode 채팅에서)
  - 전문 agent 지시문이 적용된다(런타임 로그 `[OpenCode] aidev routing`).
  - `remote_exec`가 실제로 원격 PC에서 실행된다.
  - 오류와 도구 출력이 실시간으로 표시된다.
  - 중단 후 재전송이 정상이다.
  - 부가 턴 세션이 사이드바에 보이지 않는다.

### G3. 게이트웨이 3엔진 (릴리스 ③, G4와 함께)
- [ ] G3-01 `store-aidev.ts`
  - `:8-9`에 `Engine`·`ENGINES` opencode 추가
  - `:20` `EFFORT_LADDER.opencode = ['none','low','medium','high','xhigh','max']`(프런트 `useChatProviderState.ts:25`와 같음. 실제 모델 사다리는 G5에서 모델별로)
  - `:21` `DEFAULT_EFFORT_CAP.opencode`
  - `:27` `MODEL_LADDER.opencode`(G3-02 모델)
- [ ] G3-02 `TIER_TABLE`(`routing.ts:104-110`)에 opencode 열을 추가한다(G5에서 카탈로그로 대체될 임시 표).
  - 초기 모델은 G0-02 목록을 보고 사용자가 정한다(§9 Q3). 기본안: 측정 전에는 D0~D2만 같은 모델로, D3·D4는 Go 목록에서 가장 강한 모델로 둔다.
  - `modelRank`(`:169-175`)의 alias는 claude 전용이다. opencode는 `provider/model` 전체 id로 비교한다.
- [ ] G3-03 **리터럴 제거** (전부 `ENGINES` 순회로) — GP에서 끝낸 곳: `routing.ts` 점수·usable·동점·응답, `aidev-api.ts` 가용성·usableEngines·설계 순서·입력 파싱, `store-aidev.ts` 폴백·effortCap·engineWeights·engineRuns, `tier-policy.ts`, `engine-weights.ts`, `knowledge-refresh.ts`. 남은 곳: `aidev-api.ts:456`(eval-judge 동시성), `notify.ts`, `remote-gate.ts`, `manage-users.ts` 문구, TIER_TABLE·사다리의 opencode 열
  - `routing.ts:726`, `:727`, `:740`, `:933`(응답 `engines`)
  - `aidev-api.ts:118`(as 캐스트, opencode가 들어오면 **TypeError**), `:142`(usableEngines), `:315`(설계 순서 폴백), `:382-383`, `:422`, `:436`, `:607`, `:613`(입력 파싱), `:456`(eval-judge 동시성)
  - `store-aidev.ts:276`(accountEngines 폴백), `:289`(effortCap 조립), `:440`(engineWeights 기본), `:445`(오류 문구), `:465`(`engine IN ('claude','codex')` → opencode run이 학습에서 빠짐)
  - `tier-policy.ts:39`, `:86`
  - `knowledge-refresh.ts:109-114`
  - `notify.ts:15`(`PROVIDER_LABEL`)
  - `remote-gate.ts:75`(위험 패턴에 opencode와 그 권한 우회 플래그 `--auto` 등을 추가)
  - `manage-users.ts:17`(usage 문구)
- [ ] G3-04 `engine_weights` 시드(`store-aidev.ts:205-211`)를 엔진별 `INSERT OR IGNORE`로 바꾼다. 기존 DB에 opencode 행 0.5가 생기게 한다.
- [~] 구현·로컬검증(GP에서 구현, 로컬검증), 서버 확인 대기 — G3-05 `engine-weights.ts:28`, `:36-42`의 속도 보너스를 2엔진 쌍(`const [a, b]`)에서 N엔진으로 바꾼다. 규칙: 성공률이 최고값 ±5% 안에 있는 엔진 중 가장 빠른 엔진이 나머지보다 20% 이상 빠르면 보너스.
  - 학습 가중치는 작업 우선순위를 정하지 않은 계정(점수 모드, §9 Q11)에서만 공급자 선택에 쓰인다. 우선순위를 정한 계정에서는 통계로만 남는다.
- [~] 구현·로컬검증(GP-04에서 구현, 로컬검증), 서버 확인 대기 — G3-06 `escalation.ts` 이분법을 제거한다.
  - `:45` `run.engine`을 `ENGINES`로 검증한다. 지금은 opencode run이 claude로 바뀐다.
  - `:46-47` `other`를 "우선순위상 다음 usable 공급자(limited 제외)"로 바꾼다.
  - **Q1 적용**(작업 우선순위를 정한 계정): `switch_engine`은 사용량 한도와 로그인 만료일 때만 제안한다. 지금의 "D4에서 effort를 상한까지 올렸는데도 실패하면 다른 엔진으로"(`:66-72`, `:98`)는 `ask_user`로 바꾼다(§2.6).
  - `:81`(Laya 상태 `other_engine_available`)도 같은 기준으로 계산한다.
  - 참고: `/route` 쪽은 우선순위를 정한 계정이면 이미 Q1과 같다(`routing.ts:748`이 허용·로그인·한도만 보고 순서대로 고른다). 점수 감점(최근 실패 −0.3)은 점수 모드에서만 쓰인다.
  - `NextAction`에 `from_engine`을 추가한다.
  - `laya-questions.ts:99-107`의 escalate 설명을 "다음 공급자"로 고친다.
- [ ] G3-07 `routing.ts:776`: agent.model이 **그 엔진의 사다리에 있는 모델일 때만** 적용한다. 지금은 다른 엔진의 모델 이름이 rank 2로 통과할 수 있다.
- [ ] G3-08 G1-08(채팅 엔진 limited)을 3엔진에서 다시 확인한다.
- [ ] G3-09 가용성
  - opencode `allowed`는 `accounts.engines`를 따른다. 기존 계정에 opencode를 추가하는 방법은 §9 Q5에 따른다.
  - 런타임 `GET /api/providers/opencode/models` 결과(연결된 하위 공급자 기준)를 캐시한다(60초, auth와 같이). G5의 `routable(e)`에 쓴다.
- [ ] G3-10 테스트 (`deploy/aidev/auth-gateway/test/`)
  - `engine-priority-test.mjs`: 3엔진 순서, `setEnginePriority(['gemini'])` 거부 유지
  - `engine-weights-test.mjs`: N엔진 속도 보너스
  - `usage-limit-test.mjs`: 한도 시 우선순위상 다음 엔진
  - `escalation-test.mjs`: 3엔진 체인, opencode run 식별
  - `model-floor-test.mjs`, `tier-policy-test.mjs`, `capability-routing-test.mjs`(opencode 전용 계정), `routing-floors-test.mjs`, `background-design-test.mjs`, `knowledge-refresh-test.mjs`, `notify-test.mjs`, `remote-gate-test.mjs`
  - `mock-services.mjs`: opencode auth와 models 목(mock)
  - `smoke.sh:40-47`
- [ ] G3-11 `verify-b.sh:51`의 엔진 확인을 `ENGINES` 기준으로 바꾼다. 계정이 opencode를 허용하면 `j.engines.opencode`가 있는지 확인한다.

### G4. 프런트 3엔진 (릴리스 ③)
- [ ] G4-01 `src/modules/aidev-router/api.ts:8` `Engine = AidevEngine`으로 바꾼다.
  - 서버가 키를 빠뜨릴 수 있는 `Record<Engine,…>`(`:72`, `:96-97`, `:100`, `:105`, `:264`, `:297`, `:398`)는 `Partial`로 바꾸고 소비처에 가드를 둔다.
  - `NextAction`(`:240`)에 `from_engine`을 추가한다.
- [ ] G4-02 `hooks/useAidevRouting.ts:38`의 `ENGINES`를 `AIDEV_ENGINES`로 바꾼다. **G1-09 임시 우회를 제거한다.**
- [ ] G4-03 `src/modules/chat/hooks/useChatComposerState.ts`
  - `:46` `onEngineSwitchBack` 타입
  - `:852` switchBack 조건 → `isAidevEngine(provider)`
  - `:856-857` 새 세션의 `sessionProvider` → `isAidevEngine(plannedEngine)`
- [ ] G4-04 `src/modules/chat/ChatInterface.tsx`
  - `:86`, `:88` ref 타입
  - `:103-104` 한도 자동 인계 조건
  - `:492-498` "다른 엔진 모델" → **다른 엔진들의 그룹 배열**
  - `ComposerModelMenu.tsx:36`, `:76`, `:187-200`과 `ChatComposer.tsx:65`, `:150`, `:513`을 그룹 배열로 바꾼다.
- [ ] G4-05 `AidevRouterBar.tsx`
  - `:109-115` 엔진 메뉴를 `AIDEV_ENGINES`로 하고 `engines[engine]`이 없으면 건너뛴다. 지금은 크래시한다.
  - `:173`, `:177-178`, `:188`, `:192-193`의 `defaults![engine]`, `ladder![engine].map`에 가드를 둔다.
- [ ] G4-06 `EffortCapDefaults.tsx`
  - `:17`, `:32` 엔진 목록
  - `:20-21`, `:35-37`의 `!` 인덱싱에 가드
  - `grid-cols-2` → `grid-cols-3`
- [ ] G4-07 `hooks/useEnginePriority.ts:30-37`의 2엔진 3지선다(`PRIORITY_CHOICES`, `priorityKey`)를 순서 편집으로 바꾼다. `EnginePriorityDefaults.tsx`도 같이 고친다. G5-10에서 작업 우선순위 UI가 된다.
- [ ] G4-08 한도와 인계
  - `UsageLimitPanel.tsx:5`, `hooks/useUsageLimits.ts:65` 엔진 목록
  - `hooks/useEscalation.ts:32`, `:101`(`fromEngine` 추측 → `next.from_engine`), `:136`(`otherEngine` → 다음 usable 공급자)
  - `hooks/useReturnFromHandoff.ts:15`
  - 라벨은 `ENGINE_LABELS` 하나로 쓴다.
- [ ] G4-09 `TierPolicyPanel.tsx:76` 가중치 표 열을 `AIDEV_ENGINES`로 바꾼다.
- [ ] G4-10 `hooks/useChatEffortCap.ts:49`의 쓰이지 않는 `effective`(claude/codex 하드코딩)를 제거한다.
- [ ] G4-11 모바일
  - `src-mobile/screens/ChatScreen.tsx:316` switchBack 조건
  - `components/RouterChip.tsx:23`, `:69-71`(`last.engines[engine]`에서 크래시)
  - `screens/SettingsScreen.tsx:36-39`, `:49`, `:91-99`, `:106-116`
  - `components/EffortCapControl.tsx:14-71`(`!` 인덱싱)
  - `components/SettingsSections.tsx:59-73`(opencode 새 채팅 기본 권한)
- [ ] G4-12 테스트
  - `useAidevRouting` opencode switchBack과 asEngine
  - 순서 편집
  - `usageLimitPanel.test.tsx:23-28` opencode
  - `returnFromHandoff.test.ts` 3엔진 체인
  - `composerClarifyHold.test.tsx:49` `plan.engine:'opencode'`
  - 모바일 `chatScreen.test.tsx`: opencode 세션 provider 유지
- [ ] G4-13 **서버 확인** (G3과 함께)
  - Claude·Codex 계정에 opencode를 허용하고 작업 우선순위를 `opencode > claude > codex`로 두면 새 채팅이 OpenCode로 시작한다.
  - OpenCode 로그아웃이나 한도 상태에서는 Claude로 시작하고, 복귀 가능해지면 `switch_back`이 동작한다.
  - 실패 escalate가 다음 공급자로 인계된다.
  - 라우터 바와 모바일 칩에 OpenCode가 표시된다.

### G5. 공급자 정책 (릴리스 ④ 게이트웨이·런타임 → ⑤ UI)
- [~] 구현·로컬검증(GP-02 — 단 `engine_models` 표는 아직 없음: 카탈로그는 코드 상수 `MODEL_CATALOG`(claude·codex), OpenCode 모델 동기화가 필요한 G3에서 표로 옮김), 서버 확인 대기 — G5-01 데이터 모델(§3.1): `engine_models`, `model_scores`, `accounts.model_ceiling/effort_floor/model_ladder/verify_priority`. §9 Q6 결정에 따라 `session_settings` 컬럼과 정리 DELETE 조건도 고친다.
- [ ] G5-02 **카탈로그**
  - 시드: `TIER_TABLE`의 claude·codex 모델과 level.
  - 강도 단계는 런타임 모델 카탈로그(`/api/providers/<engine>/models`의 `effort.values`)에서 읽는다(claude haiku는 없음 → 한 칸).
  - opencode: 런타임 카탈로그를 `source='runtime'`, `level=NULL`로 동기화한다(G3-09 캐시를 쓴다).
  - 관리자 API `PUT /engine-models`, `manage-users engine-model`
  - level 측정 방법: `judge-eval.jsonl` 등급별 사례를 해당 모델로 실행하고 성공률로 판단한다. 수동 평가로 대신할 수 있다. 측정 결과를 기록한다.
- [~] 구현·로컬검증(GP-07), 서버 확인 대기 — G5-02a **지능 점수 동기화** (게이트웨이 새 모듈 `model-scores.ts`, 접근은 `store` 경유)
  - 하루 1회와 관리자 요청 시 AA 무료 API를 호출한다. 키는 `app_kv aa.api_key`이며 로그와 응답에 노출하지 않는다.
  - `model_scores`의 `aa_slug`로 매칭해 Coding·Intelligence·Agentic 세 지수의 `source='aa'` 점수를 함께 갱신한다(`index_name`별 행). 관리자 점수(`source='admin'`)는 덮어쓰지 않는다.
  - 지수 버전이 바뀌면 모든 AA 점수를 새 버전으로 한꺼번에 바꾼다. 일부만 바뀐 상태로는 분할에 쓰지 않는다.
  - 빈칸을 추정한다(§9 Q14). 같은 모델의 강도 사이는 직선 보간하고, 한 강도만 있으면 같은 공급자의 강도별 평균 차이를 적용한다. 결과는 `source='estimated'`.
  - 실패(네트워크, 키 없음)하면 마지막 값을 유지한다. 점수가 전혀 없으면 칸 수 분할로 대신한다(§2.3).
  - 매핑 시드: G0-09 초안. `PUT /model-scores`로 관리자가 고친다.
  - 테스트: 버전 교체, 관리자 값 보존, 보간과 추정, 실패 시 유지, 키 비노출.
- [~] 구현·로컬검증(GP-02), 서버 확인 대기 — G5-02b **강도 하한**
  - `accounts.effort_floor`, `PUT /settings/effort-floor`, 공통 강도 순서 상수(`none < minimal < low < medium < high < xhigh < max < ultra`)를 `store-aidev.ts`의 `EFFORT_LADDER` 옆에 둔다.
  - 하한이 상한보다 위면 400. 모델에 범위 안 강도가 없으면 범위에 가장 가까운 강도 한 칸으로 한다(§2.3).
  - 채팅별 강도 하한은 두지 않는다(§9 Q6).
- [~] 구현·로컬검증(GP-03 (`routing.ts` 기존 우선순위 경로 + 한도 시 switch_back)), 서버 확인 대기 — G5-03 **공급자 선택** `pickProvider(order)`(§2.2, `routing.ts`)
  - 작업 우선순위를 정한 계정: 순서대로 고르고, **한도**(그리고 실행 불가 — 미허용·로그인 안 됨, §9 Q12)일 때만 다음으로 넘긴다. 실행 불가로 건너뛴 것은 사용자에게 알리지 않고 결정 기록에만 남긴다.
  - 정하지 않은 계정: 지금의 점수 방식(§9 Q11).
  - 채팅 엔진: 한도이면 `switch_back` 제안(G1-08), 더 높은 순위가 한도에서 풀리면 복귀 제안(기존).
  - 수동 고정(pinned)과 `preferEngine`은 예외로 그대로 둔다.
- [~] 구현·로컬검증(GP-01·GP-03 (`pickStep`, `splitTier`)), 서버 확인 대기 — G5-04 **모델·강도 선택** `pickStep(e, d)`(§2.3)
  - `steps(e)` = 사다리[모델 하한..상한] × 모델별 강도[강도 하한..상한].
  - `d > level(모델 상한)`이면 **Q2: 상한 모델·최대 강도**.
  - 아니면 **점수 분할**: 점수 오름차순에서 `lo + d/4 × (hi − lo)` 이상인 첫 조합. 점수가 빠진 칸이 있으면 칸 수 분할 `steps[round(d/4 × (n-1))]`로 대신하고 사유를 기록한다.
  - 모델 하한·상한과 강도 하한을 하나도 정하지 않은 공급자는 지금 규칙(`TIER_TABLE` → tier_policy → agent.model → `applyModelFloor` → `applyEffortCap`)을 그대로 쓴다.
  - 분할 모드에서는 tier_policy를 쓰지 않는다. agent.model은 범위 안이고 고른 조합보다 점수가 높거나 같을 때만 적용한다.
  - 응답 `plan.step = {index, total, q2, mode: 'score'|'steps'|'tier', target, score}`, 사유 기록("D3 > 상한 sonnet(2) → 상한·최대", "D2 목표 48 → opus·medium 52(AA)").
- [~] 구현·로컬검증(GP-08 (`GET /engines`의 `policy.providers.*.preview`)), 서버 확인 대기 — G5-05 **미리보기**: `GET /engines`의 `preview`(공급자마다 D0~D4 → `pickStep` 결과). 설정 UI가 이 값만 표시한다(계산 중복 금지).
- [~] 구현·로컬검증(GP-05), 서버 확인 대기 — G5-06 **검증 후보를 게이트웨이로 옮긴다**(§2.4)
  - `aidev-api.ts:223-284`가 `candidates`를 계산해 런타임 `/verify`에 넘긴다.
  - 검증 우선순위를 정했으면 그 순서를 그대로 따른다(Q1). 정하지 않았으면 지금처럼 작업자와 다른 공급자를 우선한다.
  - 난이도는 `max(d, 3)`이다. 작업자와 같은 공급자면 작업자 조합의 점수 이상으로 한다.
  - 런타임 `run-verifier.service.ts:56-89`는 후보를 순서대로 시도하도록 바꾸고(실행 오류·과부하·한도일 때만 다음), LADDER 중복을 제거한다.
  - 한 릴리스 동안은 `candidates`가 없으면 기존 방식으로 동작하게 한다(하위 호환).
  - 테스트 `run-verifier.test.ts`
- [~] 구현·로컬검증(GP-06 (설계·지식 점검·교훈 정제 모두 작업 순서)), 서버 확인 대기 — G5-07 **부가 턴**(§2.5): design `pickStep(e, 3)`, curate `pickStep(e, 0)`, knowledge `pickStep(e, 1)`. 공급자는 모두 `pickProvider(work_priority)`로 고른다. 판정은 제외한다(§9 Q4).
- [~] 구현·로컬검증(GP-04), 서버 확인 대기 — G5-08 **escalation**(§2.6)
  - `escalate_tier`는 같은 공급자에서 `pickStep(e, d+1)`로 고른다. 이미 상한·최대이면 `ask_user`로 간다.
  - `switch_engine`은 한도와 실행 불가일 때만 `pickProvider`로 다음 공급자를 고른다.
- [~] 구현·로컬검증(GP-08 (범위는 `PUT /settings/provider-policy` 하나로 한꺼번에)), 서버 확인 대기 — G5-09 **API**(§3.2): `GET /engines` 확장(`models`, `model_ceiling`, `model_ladder`, `verify_priority`, `preview`), `PUT /settings/model-ceiling|model-ladder|verify-priority`.
  - `PUT /settings/engine-priority`의 의미가 "작업 우선순위"로 바뀐다. 빈 배열은 400.
  - 검증 규칙
    - 하한이 상한보다 위이면 400
    - 하한·상한은 사다리 안에 있어야 한다
    - 사다리는 카탈로그 모델만
    - 순서 목록은 `ENGINES`만
  - `manage-users` 명령과 `nadovibe_settings` 키를 추가한다(`app-control.service.ts`).
- [~] 구현·로컬검증(GP-09 (범위 카드는 공급자별 「모델·강도 범위」 탭)), 서버 확인 대기 — G5-10 **작업대 설정 UI**(§3.4)
  - Agents 탭 "라우팅" 영역: 점수 지수 선택(기본 Coding), 작업 우선순위, 검증 우선순위, 공급자 카드 3개(사다리·하한·상한·강도 상한·D0~D4 미리보기).
  - 훅은 `src/modules/aidev-router/hooks/`에(`useProviderPolicy` 등), 컴포넌트는 `aidev-router`에서 barrel로 export한다(표준: 소비 모듈과 이유를 주석으로).
  - 저장하면 `aidevApi`의 PUT을 호출하고, 응답의 `preview`로 미리보기를 갱신한다. 실패하면 되돌린다.
- [~] 구현·로컬검증(GP-09), 서버 확인 대기 — G5-11 **모바일 설정 UI**: `SettingsScreen.tsx` 엔진 우선순위 아래에 같은 항목을 시트로 둔다(미리보기 포함).
- [~] 구현·로컬검증(GP-10), 서버 확인 대기 — G5-12 **라우터 바 표시**: 선택 사유를 한 줄로 보여준다. 예: "작업 1순위 OpenCode 한도(14:00) → Claude · D3 → opus·medium (8칸 중 5)", "D4 > 상한 sonnet → sonnet·xhigh(상한·최대)". 모바일 RouterChip 상세에도 표시한다.
- [~] 구현·로컬검증(GP-03), 서버 확인 대기 — G5-13 `decision_log.answer`에 공급자 평가(선택, 한도로 건너뜀, 실행 불가로 건너뜀)와 `step`(index/total/q2)을 기록한다(E-07/E-08 학습 자료).
- [~] 구현·로컬검증(GP — `provider-policy-test.mjs`·`providerPolicySettings.test.tsx`·런타임 verifier/curator 테스트. OpenCode 관련 단언은 G3에서 추가), 서버 확인 대기 — G5-14 **테스트(관문)**
  - **동등성**: 정책이 빈 계정에서 depth 0~4 × claude/codex의 엔진·모델·effort가 지금 `TIER_TABLE`, 하한, 강도 상한 결과와 같다(기존 테스트 전부 통과 + 표 기반 테스트 신설).
  - **점수 분할**: §2.3 예시 1(가상 점수)을 그대로 단언한다. 같은 점수의 순서, 약한 모델의 높은 강도가 끼어드는 경우, 강도 하한·상한이 칸을 줄이는 경우, 점수 빈칸이 있으면 칸 수 분할로 대신하는 경우를 확인한다.
  - **칸 수 분할**: §2.3 예시 2 표 4행을 그대로 단언한다. 강도가 없는 모델(haiku), opencode 모델별 강도(GLM low·high·max)도 확인한다.
  - **Q2**: `d > level(상한)`이면 상한·최대 강도이고, 다른 공급자로 넘기지 않는다.
  - **Q1**: 1순위가 최근 실패·낮은 학습 점수·상한 미달이어도 1순위를 유지한다. 한도일 때만 2순위로 간다. 한도가 풀리면 복귀를 제안한다.
  - 검증: 검증 우선순위 순서 그대로, 정하지 않았을 때 교차 검증, 같은 공급자일 때 작업자 칸 이상.
  - escalation: 상한·최대에서 실패하면 `ask_user`, 한도면 다음 공급자.
  - opencode level 미측정(2) 처리, 런타임 verify 후보 순차 시도, 프런트 설정 UI 훅 테스트.
- [ ] G5-15 **서버 확인**
  - 정책이 없는 계정의 라우팅 결과가 이전 릴리스와 같다(`decision_log` 비교 표본 20건).
  - 작업 우선순위 1순위가 한도일 때만 2순위로 가고, 풀리면 복귀를 제안한다.
  - 모델·강도의 하한·상한을 정하면 미리보기와 실제 선택(`plan.step`)이 일치한다. 상한이 모자라면 상한·최대로 실행된다.
  - AA 점수가 동기화되고(`/model-scores`의 `synced_at`, 버전), 설정 화면에 출처가 표기된다.
  - 검증 우선순위대로 검증 엔진이 정해진다(`runs.verification.engine`).

### G6. 검증·배포·문서 (매 릴리스)
- [ ] G6-01 로컬 관문(ship.sh와 같음): `npm run typecheck`, `npm run lint`, `npm test`(server), `npm run test:client`, `npm run build`, 게이트웨이와 runtime-manager `npm test`
- [ ] G6-02 로컬 플랫폼 e2e: `deploy/aidev/release/local-platform.sh`에 opencode를 설치한 런타임으로 라우팅과 opencode 실행을 확인한다(목(mock) Laya).
- [ ] G6-03 **배포 순서**
  - 릴리스 ①
    - 서버 `.env`에 `OPENCODE_VERSION`을 넣고 `runtime-image.sh build`를 실행한다. ship은 이미지를 빌드하지 않는다.
    - push한 뒤 `relay.sh ship jazzlife`를 실행한다.
    - 런타임을 재생성한다. 멈춘 런타임만 자동 재생성되므로(`runtime-manager.ts:98-100` stale 검사), 실행 중인 런타임은 하나씩 stop → rm → 로그인으로 재기동한다.
  - 릴리스 ② ~ ⑤: ship만 한다.
- [ ] G6-04 `verify-b.sh` 항목 추가
  - 런타임에 `opencode --version`이 있는지(이미지 반영 확인)
  - `/engines`에 opencode가 있는지
  - (G5) 정책이 빈 계정의 동등성 표본
  - 검증 후보 순서
  - 서버의 verify-b는 별도 사본이므로 scripts로 동기화한다(메모리: ship 후 검증 함정).
- [ ] G6-05 판정 평가 회귀: `POST /api/aidev/route/eval-judge`의 기존 기준(agent ≥0.85, level ≥0.8, D4 ≥2/3, 핸드오프 ≥0.85)이 유지되는지 확인한다.
- [ ] G6-06 문서
  - IMPLEMENTATION-PLAN.md를 갱신한다.
    - §0 확정된 결정: 실행 엔진에 OpenCode 추가, 원칙 4 허용 지점
    - §1 상태표 G행
    - §3.2 데이터 모델
    - §3.3 API
    - §3.4 등급·정책(카탈로그, 공급자 순서 Q1, 균등분할·Q2 — 정하지 않은 항목은 등급표)
    - §3.5 OpenCode 어댑터
  - 이 문서의 체크와 릴리스 ID를 적는다.

---

## 6. 테스트·검증 계획 요약
| 계층 | 도구 | 핵심 단언 |
|---|---|---|
| 게이트웨이 | `deploy/aidev/auth-gateway/test/*-test.mjs`(`run-all.mjs`) | 동등성 표, 3엔진 우선순위·한도·escalation, 상한 건너뛰기, 검증 후보, 시드 마이그레이션(기존 DB에 opencode 행) |
| 런타임 | `npm test`(`server/**/*.test.{ts,js}`) | opencode 이벤트 정규화(실측 픽스처), aidev 설정 주입(env·args), 한도·인증 감지, 부가 턴 opencode, 엔진 필터 빈 배열 오류 |
| 프런트 | `npm run test:client` | Cursor 숨김, 3엔진 라우터 바와 패널 가드, opencode 세션 provider 유지(작업대·모바일), 인계 `from_engine` |
| 통합 | `local-platform.sh`, `smoke.sh` | opencode 런타임으로 route → 실행 → outcome → 검증 |
| 서버 | `verify-b.sh`, 실사용 | §5 각 단계의 "서버 확인" |

---

## 7. 배포·운영 메모
- 런타임 이미지 재빌드는 ship 경로 밖이다. `runtime-image.sh build`는 서버에서 직접 실행한다. `.env`의 `OPENCODE_VERSION`을 빠뜨리면 빌드가 실패하게 한다(`:?`).
- OpenCode 자격증명은 home 볼륨(`~/.local/share/opencode/auth.json`)에 있어 런타임을 재생성해도 남는다. 사용자별로 각자 로그인한다.
- 자동 업데이트를 끄지 않으면 전역 설치 경로에 쓰기를 시도할 수 있다(사용자 1001, `/usr/local`은 root 소유). G0-01에서 확인한다.
- OpenCode 버전 올리기 = `.env` 수정 → 이미지 재빌드 → 런타임 재생성 → G0-03 이벤트 형식 회귀 테스트.

---

## 8. 위험과 대응
| 위험 | 대응 |
|---|---|
| opencode CLI 이벤트·설정 형식이 버전마다 바뀜 | 버전 고정(G0-01), 실측 픽스처 테스트(G2-01), 버전을 올릴 때 회귀 |
| 3번째 엔진 키가 없어 프런트·게이트웨이가 크래시(`as` 캐스트, `!` 인덱싱) | G3-03·G4-05·G4-06·G4-11에서 `ENGINES` 순회와 가드, Partial 타입 |
| Claude·Codex 계정의 라우팅 결과가 바뀜(회귀) | G5-14 동등성 관문, G5-15 서버 표본 비교 |
| opencode 모델 등급을 모름(GLM·Kimi 등) | 미측정 level 2, 측정 후 관리자가 조정(G5-02). 상한으로 둔 opencode 모델이 level 2면 D3·D4는 Q2에 따라 상한·최대로 실행됨 — 미리보기에 표시 |
| AA에 우리 조합의 점수가 없거나(새 모델, 별칭 변경, 일부 강도만 측정) 지수 버전이 바뀌어 척도가 달라짐 | 매핑은 관리자가 관리(G0-09·G5-02a), 빈칸은 보간·추정으로 채우고 "추정"으로 표시, 버전이 섞이면 분할에 쓰지 않음, 그래도 없으면 칸 수 분할 |
| AA 지수는 범용 지능 점수라 코딩 agent 작업의 실제 난이도와 다를 수 있음 | 기본을 Coding Index로 하고, 사용자가 계정 설정에서 바꿈(`score_index`: coding / intelligence / agentic, §9 Q13). 서버 run 성공률로 사후 확인(E-07) |
| 균등분할을 사다리 전체로 걸면 같은 난이도에 더 강한 모델을 써서 비용·한도 소진이 빨라짐(§2.3 예시) | 설정 화면 D0~D4 미리보기(G5-05·G5-10), 강도 상한으로 칸 수 제한, 정하지 않은 공급자는 등급표 유지(§9 Q11) |
| 1순위 공급자가 계속 실패해도 순서를 바꾸지 않음(Q1) | 실패는 같은 공급자 안에서 escalate_tier → 상한·최대에서도 실패하면 ask_user(사용자가 순서나 채팅 고정을 바꿈). 실패 통계는 라우터 바와 카탈로그에 표시 |
| 부가 턴 세션이 사용자 대화 목록에 섞임 | 임시 폴더 실행과 동기화기 제외(G2-12) |
| OpenCode Go 한도를 감지 못해 인계가 안 됨 — Q1에서는 한도만이 넘기는 사유라 치명적 | G0-06 실측과 G2-05 감지 테스트를 관문으로. 감지가 안 되는 오류 형태가 남으면 그 오류를 한도로 분류하는 규칙을 추가하고, 그때까지는 사용자 수동 전환 |
| 빈 엔진 목록이 "전부 허용"으로 해석됨(D-05) | G1-07에서 빈 배열은 오류로 처리 |
| Google 구독 OAuth 사용 시 계정 정지 | 지원하지 않음. Zen 또는 API 키만(§9 Q8) |
| 런타임 이미지 반영 누락 | verify-b에 `opencode --version` 확인(G6-04) |
| upstream merge 충돌 증가 | 허용 지점 목록 갱신(G1-12). upstream merge는 보류 중(메모리: upstream merge 보류) |

---

## 9. 열린 결정 (기본값으로 진행, 바뀌면 여기와 §2를 갱신)
- **Q1 공급자 순서 — 확정(2026-10-13 사용자)**: 공급자 우선순위는 반드시 지킨다. **사용량 한도에 걸렸을 때만** 다음 순위로 넘긴다. 공급자 안에서는 [모델 하한~상한] × [강도 하한~상한] 조합을 지능 점수 구간으로 균등분할하고 난이도에 따라 고른다(§2.2·§2.3). 공급자 선호 점수(가중치 슬라이더)는 두지 않는다. "가중치 단계" = 추론 강도(사용자 확인). 모델 하한·상한과 강도 하한·상한을 모두 설정할 수 있게 하고, 분할 기준은 (모델, 강도) 조합의 지능 점수로 한다(Q13, 점수가 없으면 칸 수).
- **Q2 상한 미달 — 확정(2026-10-13 사용자)**: 상한 모델이 그 난이도를 수월하게 해낼 등급에 못 미치면(`d > level(상한)`) **상한 모델 + 최대 강도**(강도 상한 이내)로 실행한다. 다른 공급자로 넘기지 않는다.
- **Q3 opencode 모델 등급 초기값** → 기본값: 미측정 level 2. G3의 임시 TIER_TABLE opencode 열은 G0-02 목록을 보고 사용자가 정한다.
- **Q4 판정(judge) 공급자** → 기본값: Claude sonnet → Codex terra 유지. opencode 전용 계정은 판정 없이 generalist가 된다(지금 "판정 없음" 경로). 이 경우 품질이 떨어지는지 G6에서 확인한다.
- **Q5 기존 계정의 opencode 허용** → 기본값: 관리자가 `manage-users engines USER claude,codex,opencode`로 명시한다. `accounts.engines` DEFAULT는 그대로 둔다.
- **Q6 채팅별 상한·모델 우선순위** → 기본값: 계정 단위만 둔다. 채팅별은 기존 하한·effort 상한만 유지.
- **Q7 OpenCode 버전 — 확정**: **1.19.0**(2026-10-13 서버 실측, §2.8). 올릴 때는 §2.8의 실측을 다시 한다.
- **Q8 Gemini 경로** → 기본값: OpenCode Zen(코드 변경 없음). Google API 키를 쓰려면 G1-11. Antigravity OAuth는 금지.
- **Q9 설정 UI 위치** → 기본값: 작업대 설정 → Agents 탭 상단 "라우팅" 영역. 대안: 별도 "라우팅" 탭.
- **Q11 정하지 않은 항목의 동작** → 기본값: **지금 동작 그대로**. (구현) 분할 모드는 모델 사다리를 저장한 공급자에만 적용된다(§2.1).
  - 작업 우선순위가 없으면 학습 점수로 고른다.
  - 하한·상한이 둘 다 없는 공급자는 등급표를 쓴다.
  - 검증 우선순위가 없으면 교차 검증을 한다.
  - 대안: 정하지 않아도 사다리 전체를 균등분할한다. 이러면 지금보다 같은 난이도에 강한 모델을 쓴다(§2.3 예시 둘째 행). Claude 기준 D2가 sonnet·high에서 opus·medium으로, D3이 opus·high에서 best·low로 바뀐다.
- **Q12 로그인 안 된(또는 허용되지 않은) 공급자 — 확정(2026-10-13 사용자)**: 건너뛴다. 사용자에게 따로 알리지 않는다(라우터 바 문구·푸시 없음). `decision_log`에만 사유를 남긴다. Q1의 "한도일 때만"은 실행 가능한 공급자 사이의 규칙이다.
- **Q13 지능 점수 출처 — 확정(2026-10-13 사용자)**: Artificial Analysis의 **Coding Index가 기본**이다. 사용자가 계정 설정에서 Intelligence·Agentic Index로 바꿀 수 있다(`accounts.score_index`, `PUT /settings/score-index`, 설정 화면의 공급자 카드 위 선택 상자). 하루 1회 세 지수를 모두 동기화하고, 화면에 출처를 표기한다. 참고: LMArena 같은 사람 투표 점수는 모델 단위만 있고 강도별 점수가 없어 이 용도에 맞지 않는다. 자체 측정(judge-eval 사례를 조합별로 실행)은 비용이 커서 나중에 한다.
- **Q14 점수 빈칸 추정** → 기본값: 같은 모델의 강도 사이는 직선 보간한다. 한 강도만 있으면 같은 공급자의 강도별 평균 차이를 적용한다. 같은 공급자에 기준이 없으면 점수 없음으로 두고, 그 공급자는 칸 수 분할로 대신한다. 추정값은 "추정"으로 표시한다.
- **Q15 지수 버전 변경** → 기본값: 새 버전 점수가 모든 매핑 항목에 대해 들어올 때까지 이전 버전 점수를 계속 쓰고, 한 번에 교체한다.
- **Q10 upstream 수정 허용 지점 추가**(원칙 4) → 기본값으로 다음을 허용한다:
  - `server/modules/providers/list/opencode/*`
  - `server/modules/providers/services/provider-usage-limits.service.ts`
  - `server/modules/providers/services/provider-token-usage.service.ts`
  - `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`
  - `src/modules/chat/modals/ModelLibraryPanel.tsx`
  - `src/modules/chat/composer/ComposerModelMenu.tsx`
  - `src/modules/chat/composer/ChatComposer.tsx`
  - `src/modules/settings/tabs/agents-settings/*`
  - `src/modules/onboarding/AgentConnectionsStep.tsx`
  - `src/modules/provider-auth/hooks/useProviderAuthStatus.ts`
  - `src/shared/selectedProvider.ts`
  - `src/shared/types.ts`
  - `src/shared/constants.ts`
  - `src/shared/utils.ts`

---

## 부록 A. 엔진 결합 지점 전수 목록 (2026-10-13 조사)

### A.1 게이트웨이 (`deploy/aidev/auth-gateway/src/`)
- 정의: `store-aidev.ts:8-9`, `:20-21`, `:27`, `:57`
- 리터럴과 캐스트: `routing.ts:726`, `:727`, `:740`, `:767`(동점이면 claude), `:933`, `aidev-api.ts:118`, `:142`, `:315`, `:382-383`, `:422`, `:436`, `:456`, `:607`, `:613`, `store-aidev.ts:209`, `:276`, `:289`, `:440`, `:445`, `:465`, `tier-policy.ts:39`, `:86`, `engine-weights.ts:28`, `knowledge-refresh.ts:109-114`, `notify.ts:15`, `remote-gate.ts:75`, `manage-users.ts:17`
- 이분법: `escalation.ts:45-47`, `engine-weights.ts:36-42`(속도 보너스 `[a, b]`)
- 잠재 결함: `routing.ts:750`(채팅 엔진 limited 미검사), `routing.ts:776`(다른 엔진 모델이 rank 2로 통과)
- Claude 전용(유지 여부 결정): `push.ts`, `aidev-api.ts:545-554` `/claude-auth`, `store-aidev.ts:173-175`, `:263-271`
- 테스트: `engine-priority`, `engine-weights`, `usage-limit`, `escalation`, `model-floor`, `tier-policy`, `capability-routing`, `routing-floors`, `background-design`, `knowledge-refresh`, `notify`, `push`, `remote-gate`, 픽스처(`clarify-question`, `create-queue`, `judge-speed`, `target-routing`), `mock-services.mjs:7`, `:119-120`, `smoke.sh`
- 배포 검증: `deploy/aidev/release/verify-b.sh:33`, `:51`, `:54`, `:59-74`

### A.2 런타임 (`server/`)
- aidev 옵션: `aidev-tools.service.ts:242-264`, `:278-336`(`:323` 화이트리스트), `:343-360`, `:375-389`
- Claude 어댑터 `claude-runtime.provider.js:230-268`, `:991` / Codex 어댑터 `codex-runtime.provider.ts:300-323`, `:383-396` / OpenCode 어댑터는 없다. 실행은 `opencode-runtime.provider.js:250-298`.
- 사용량 한도: Claude `:605-728`, `:1206-1241`, Codex `:67-69`, `:498-576`, 공통 `provider-usage-limits.service.ts:32`, `:154-160`, `:193-216`
- 부가 턴: `aidev-tools.routes.ts:31`, `:65-66`, `:87-92`, `:116`, `:144`, `specialist-judge.service.ts:36`, `:151-315`, `codex-judge.client.ts`, `agent-designer.service.ts:26`, `:105-145`, `run-verifier.service.ts:25-89`, `:101-102`, `:186-257`, `lesson-curator.service.ts:18-20`, `:77-126`, `knowledge-check.service.ts:21`, `:87-122`, `handoff.service.ts:9-10`
- 설정과 MCP: `app-control.service.ts:68-70`, `:106-119`, `aidev-tools-mcp.ts:135`, `:403`, `:421`, `aidev-tools-mcp.routes.ts:232`, `local-agent.ts:10`
- OpenCode 세부: 이벤트 `opencode-sessions.provider.ts:205-302`, 토큰 `opencode-runtime.provider.js:66-124`, `provider-token-usage.service.ts:279-338`, `:396-406`, 중단 `:405-417`, 동기화기 `opencode-session-synchronizer.provider.ts:84-96`, 인증 `opencode-auth.provider.ts:18-117`, 카탈로그 `opencode-models.provider.ts:28-293`, `:296-340`
- 이미지: `deploy/aidev/runtime/Dockerfile:6-13`, `entrypoint.mjs:19`, `release/runtime-image.sh:16-20`, `.env.example:3`

### A.3 프런트 (`src/`, `src-mobile/`)
- Cursor 노출: `ProviderSelectionEmptyState.tsx:29-34`, `ModelLibraryPanel.tsx:22-27`, `AgentsSettingsTab.tsx:45-47`, `AgentConnectionsStep.tsx:19-25`, `useProviderAuthStatus.ts:7`, `selectedProvider.ts:19`
- Cursor 매핑(유지): `src/shared/types.ts:8`, `src/shared/constants.ts:120-219`, `LLMProviderLogo.tsx:17-18`, 라벨 다수, `useChatProviderState.ts:34`, `:39`, `:52`
- aidev-router: `api.ts:8`, `:66-105`, `:147-148`, `:240`, `:262-301`, `:328`, `:391-404`, `hooks/useAidevRouting.ts:38`, `:48`, `:139-140`, `:175-181`, `:206-207`, `AidevRouterBar.tsx:82-84`, `:109-115`, `:173-193`, `EffortCapDefaults.tsx:16-37`, `hooks/useEnginePriority.ts:30-37`, `UsageLimitPanel.tsx:5`, `hooks/useUsageLimits.ts:65`, `TierPolicyPanel.tsx:76`, `hooks/useEscalation.ts:32`, `:101`, `:136`, `hooks/useReturnFromHandoff.ts:15`, `hooks/useModelFloor.ts:6-9`, `hooks/useChatEffortCap.ts:49`
- 채팅: `useChatComposerState.ts:46`, `:852`, `:856-857`, `ChatInterface.tsx:86`, `:88`, `:103-104`, `:486`(버그), `:492-498`, `:507`, `ComposerModelMenu.tsx:36`, `:76`, `:187-200`, `ChatComposer.tsx:65`, `:150`, `:513`
- 모바일: `ChatScreen.tsx:50`(버그), `:152`(버그), `:316`, `RouterChip.tsx:23`, `:69-71`, `SettingsScreen.tsx:36-39`, `:49`, `:91-117`, `EffortCapControl.tsx:14-71`, `SettingsSections.tsx:59-73`, `ProjectScreen.tsx:133`, `GitSheet.tsx:87`
- 설정 UI 위치: 작업대 `AgentsSettingsTab.tsx:87` 상단 블록, 채팅별은 `AidevRouterBar.tsx:164-200`, 관리자 가중치·등급은 `AgentCatalog.tsx:91` → `TierPolicyPanel.tsx`, 모바일은 `SettingsScreen.tsx:72-139`와 `RouterChip.tsx:39`
