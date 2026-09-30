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

## OS별 빌드·설치 (`scripts/`)
| OS | 빌드 (그 PC에서) | 설치·페어링·상시 실행 |
|---|---|---|
| Linux (x64, ARM64, ARMv7 — 라즈베리 파이 등 SBC 포함) | `scripts/build-linux.sh [--install --code <코드>]` | `scripts/install-linux.sh` — systemd 사용자 서비스(+linger), 없으면 백그라운드 + cron @reboot |
| macOS (Apple Silicon·Intel, universal) | `scripts/build-macos.sh [--install] [--cross]` | `scripts/install-macos.sh` — LaunchAgent (ops: `./runner/build.sh mac` → `./runner/install.sh`) |
| Windows (x64, ARM64) | `scripts\build-windows.ps1 [-InstallTools] [-Install -Code <코드>]` | `scripts\install-windows.ps1` — 로그온 작업, 콘솔 창 없이(`start --hidden`), 로그 `%USERPROFILE%\.aidev\runner.log` |
| Android · iPhone | 러너가 돌지 않음 — 연결된 PC의 러너가 adb / Xcode(simctl)로 다룸 | |

- 설치 스크립트는 `--file`/`--dist`(직접 빌드한 것) 또는 게이트웨이에서 내려받기(SHA-256 확인)를 쓰고, `--code`면 페어링, 이전 러너를 멈추고 교체한 뒤 **연결까지 확인**한다.
- 게이트웨이가 스크립트와 소스를 제공: `/_runner/scripts/<이름>`, `/_runner/source/aidev-runner-src.tar.gz`(릴리스에 이 OS·CPU의 바이너리가 없을 때 그 PC에서 빌드). 예:
  - Linux: `curl -fsSL https://dev.nado.work/_runner/scripts/install-linux.sh | bash -s -- --code <코드>`
  - Windows(PowerShell): `& ([scriptblock]::Create((irm https://dev.nado.work/_runner/scripts/install-windows.ps1))) -Code <코드>`
  - 소스 빌드: `curl -fsSL https://dev.nado.work/_runner/source/aidev-runner-src.tar.gz | tar -xz && ./aidev-runner-src/scripts/build-linux.sh --install --code <코드>`
- 필요한 도구: Rust(rustup, `Cargo.toml` rust-version 이상), C/C++ 컴파일러(내장 H.264 OpenH264), x86에서는 nasm. Windows는 MSVC Build Tools(`-InstallTools`가 winget으로 설치). 각 빌드 스크립트의 `--check`/`-Check`가 빠진 것과 설치 명령을 알려준다.
- 교차 빌드(릴리스용): `./build.sh [linux-x64 linux-arm64 linux-armv7 win-x64 mac]` — Linux·Windows는 zig(cargo-zigbuild)로 glibc 2.28 링크, macOS는 Mac에서. 클라우드 릴리스는 linux-x64·linux-arm64·linux-armv7·win-x64를 포함.
- .NET Framework 디버그 어댑터: `deploy/aidev/clrdbg/build.sh`(Linux·Mac, Mono 참조 어셈블리) / `build.ps1`(Windows). Apple Silicon netcoredbg: `ops/runner/build-netcoredbg.sh`.
- `scripts/stage-dist.sh <out>`: 게이트웨이가 `/_runner/`로 제공할 것(바이너리·어댑터·스크립트·소스)을 모음 — release/pack.sh와 smoke가 사용.
- 테스트: `cargo test`(경로 검사·RPC·서비스 파일·exec 4종: 파이프 출력/exit/env 비상속, pty 입력·크기·신호, 허용 폴더·중복·제한 시간, 연결 없이 실행 후 tail), `test/e2e.sh`(mock 게이트웨이로 페어링→연결→ping→재연결→폐기 종료).
