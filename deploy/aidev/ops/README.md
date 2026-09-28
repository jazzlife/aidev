# ops/ — SSH 스트림 배포 (저장소·이미지 빌드 없음)

    ./relay.sh watch                                        # 작업 대기: Claude가 배포·확인을 직접 수행 (아래)
    ./relay.sh deploy releases/release-<sha>.tgz            # 수동 배포: tgz | ssh 'deploy.sh -'
    ./relay.sh rollback [sha]                               # 원자 전환 + 변경 컴포넌트만 재시작
    ./relay.sh status                                       # 릴리스/런타임 상태
    ./relay.sh verify USER                                  # 서버 검증 (비밀번호 없음: 서버 안에서 10분 세션)
    ./relay.sh scripts                                      # ops/scripts/*.sh → 서버 deploy/release/ (서버 스크립트 갱신 시)
    ./push-source.sh                                        # 최신 체크포인트 번들을 GitHub jazzlife/aidev에 푸시

## 작업 대기 (`./relay.sh watch`)
작업을 시작할 때 터미널에서 한 번 켜 두면(SSH 비밀번호 1회, 8시간 유지) Claude가 `outbox/<id>.job`에
한 줄짜리 작업을 쓰고, 이 스크립트가 **허용 목록에 있는 작업만** 서버에 실행한다.

| 작업 | 형식 |
|---|---|
| 배포 | `deploy releases/release-<sha>.tgz [--batch N --drain --force --canary --only a,b]` |
| 롤백 | `rollback [sha]` |
| 상태 | `status` / `list` / `diag` / `gpu` |
| 재시작 | `restart [--drain --force --batch N] gateway|runtime-manager|runtimes|laya` |
| 로그 | `logs <container> [lines]` |
| 검증 | `verify <user> [--bench --backup --experiments]` |

- 인자는 정해진 모양만 통과한다(공백 구분, `; $ \` | &` 등 특수문자 거부). 목록에 없는 작업(`sh`, `scripts`,
  `bootstrap`, `run`, `claude-token`, `fetch`)과 예전 방식(`outbox/<dir>/apply.sh`)은 실행하지 않는다.
- 결과: `inbox/job-<id>.log`(실시간), `inbox/job-<id>.status`(종료 코드 또는 `rejected`). 처리된 작업은 `outbox/done/`.
- 상태: `inbox/watch.state` — `alive <epoch> ssh=ok|down …`. Ctrl+C로 언제든 중지.

서버(`~/aidev/deploy/release/`)는 볼륨 `aidev_app`의 `releases/<sha>/`에 풀고 `current`를 원자 교체,
바뀐 컴포넌트(gateway / runtime-manager / runtimes / laya)만 `docker restart`. 프런트만 바뀌면 재시작 0.
