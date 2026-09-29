# aidev-runner — 원격 PC 러너 (IMPLEMENTATION-PLAN §3.12, 단계 F)

개발자 PC를 Nado AI Dev 플랫폼에 연결한다. **밖으로만 연결**(`wss://<gateway>/_runner/ws`)하고, 플랫폼이
만질 수 있는 곳은 `allowed_roots` 폴더뿐이다. AI 엔진은 항상 서버 런타임에서 돌고, 이 PC에서는 사용자 코드
(빌드·실행·테스트·디버그 어댑터)만 실행된다.

```
aidev-runner pair <코드> [--gateway https://dev.nado.work] [--name 이름]   # 작업대 "원격 대상"에서 받은 10분짜리 코드
aidev-runner start                        # 포그라운드 실행 (Ctrl+C 종료)
aidev-runner install-service [--print]    # 로그인 시 자동 실행: systemd 사용자 서비스 / LaunchAgent / 로그온 작업
aidev-runner uninstall-service
aidev-runner status                       # 설정 표시 (토큰은 표시 안 함)
aidev-runner caps                         # 보고할 capabilities(JSON)
aidev-runner roots list|add <폴더>|remove <폴더>   # 기본 ~/aidev-work. / 와 홈 전체는 거부
aidev-runner consent screen on|off        # 화면 캡처 동의 (기본 꺼짐)
aidev-runner unpair                       # 토큰 삭제
```

- 설정: `~/.aidev/runner.toml`(Unix 0600) — gateway, token, target_id, name, allowed_roots, screen_consent, inherit_env.
  `AIDEV_RUNNER_HOME`으로 위치 변경.
- 연결: Bearer 토큰, 접속 즉시 `runner.hello{capabilities}`(OS·아키텍처·호스트·셸·도구 버전·adb/sdb 기기·allowed_roots·화면 동의),
  15초 heartbeat, 45초 무응답이면 재연결(1초→60초 지수 backoff + jitter). 핸드셰이크 401/403 또는 close 4401이면
  토큰 폐기로 보고 종료(exit 3) → 다시 페어링.
- 프로토콜: JSON-RPC 2.0 텍스트 프레임 + 바이너리 스트림 `[streamId u32 BE][payload]`. 현재 메서드:
  `runner.ping`, `runner.capabilities`, `fs.resolve{path}`(allowed_roots 검사),
  `exec.start{cmd | program+args, cwd, env, pty, cols, rows, timeoutSec, streamId, tag}` → `{streamId, pid, cwd}`,
  `exec.write{streamId, data|b64}`, `exec.resize`, `exec.signal{INT|TERM|KILL}`(프로세스 그룹), `exec.list`, `exec.tail{bytes}`,
  알림 `exec.exit{streamId, code, signal, durationMs}` (0.2.0, F-03).
- 실행(`exec.rs`): `cmd`는 사용자 셸(zsh `-ilc`, 그 외 `-lc`; Windows `cmd /d /s /c`)로 실행해 프로필의 PATH가 적용됨.
  cwd는 allowed_roots 안(기본: 첫 허용 폴더). 환경 변수는 PATH·HOME·LANG 등 기본값 + 작업이 보낸 것만(러너 자신의 env는 `inherit_env=true`일 때만).
  pty(portable-pty, Windows ConPTY) 또는 파이프(stdout+stderr 합침). 동시 16개, 스트림별 마지막 64KB 보관.
  연결이 끊겨도 프로세스는 계속 실행(개발 서버 유지) → 재연결 후 게이트웨이가 `exec.list`로 대조·`exec.tail`로 놓친 출력 복구.
  러너 종료(Ctrl+C·서비스 중지) 시 실행 중인 명령은 모두 종료.
- 경로 검사(`roots.rs`): 심볼릭 링크·`..` 해석 후 허용 폴더 안인지 확인. 아직 없는 경로는 가장 가까운 기존 상위로 확인.

## 빌드
- 클라우드: `./build.sh` → `dist/aidev-runner-<ver>-linux-x64` (zig로 glibc 2.28 링크, 설치된 std가 있는 대상만).
  이 작업 환경은 static.rust-lang.org 접근이 막혀 다른 대상의 std를 받을 수 없음 → Windows·ARM·macOS는 Mac에서.
- Mac: `ops/runner/build.sh` → macOS universal(+ zig·cargo-zigbuild가 있으면 Windows x64, Linux arm64).
- 테스트: `cargo test`(경로 검사·RPC·서비스 파일·exec 4종: 파이프 출력/exit/env 비상속, pty 입력·크기·신호, 허용 폴더·중복·제한 시간, 연결 없이 실행 후 tail), `test/e2e.sh`(mock 게이트웨이로 페어링→연결→ping→재연결→폐기 종료).
