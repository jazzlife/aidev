# NadoVibe 러너 설치

내 PC를 NadoVibe에 연결해 agent가 그 PC에서 실행·디버깅·화면 보기를 할 수 있게 합니다. PC의 터미널에 한 줄을 붙여 넣으면 설치·페어링·서비스 등록까지 끝납니다. (같은 내용의 HTML: `runner-install.html` — 브라우저로 열고 페어링 코드를 넣으면 명령에 채워집니다.)

**페어링 코드 받는 곳**: 작업대 **원격 대상 → 등록**, 또는 휴대폰 **메뉴(☰) → PC 연결 → +**. 10분 동안 한 번만 쓸 수 있습니다. 이미 연결된 PC를 업데이트할 때는 코드가 필요 없습니다. 아래 `<코드>`를 받은 코드로 바꾸세요.

## Windows

PowerShell (관리자로 열 필요 없음)

```powershell
& ([scriptblock]::Create((irm https://dev.nado.work/_runner/scripts/install-windows.ps1))) -Code <코드>
```

- 설치 중 **UAC 확인 창이 한 번** 뜹니다. "예"를 누르면 관리자 권한으로 등록됩니다.
- 부팅 직후부터 실행(로그인 전에도 연결), 로그인하면 화면·원격 제어·알림 영역 아이콘까지 동작합니다.
- 설치 위치 `%USERPROFILE%\.aidev\bin\aidev-runner.exe` · 로그 `%USERPROFILE%\.aidev\runner.log`

제한해서 설치 (일반 사용자 권한, 로그인한 동안만):

```powershell
& ([scriptblock]::Create((irm https://dev.nado.work/_runner/scripts/install-windows.ps1))) -Code <코드> -Limited -LogonOnly
```

## macOS

터미널

```bash
curl -fsSL https://dev.nado.work/_runner/scripts/install-macos.sh | bash -s -- --code <코드>
```

- **Mac 로그인 비밀번호(sudo)**를 한 번 묻습니다. 부팅 직후 실행과 관리자 권한 설정에 씁니다.
- 처음 실행할 때 macOS가 **화면 기록**과 **손쉬운 사용** 허용을 한 번 묻습니다. 시스템 설정에서 aidev-runner를 켜 주세요. 이 Mac 전용 서명으로 설치되므로 업데이트해도 다시 묻지 않습니다.
- 메뉴 막대 아이콘: 초록 연결됨 · 주황 연결 중 · 빨강 정지됨.
- 설치 위치 `~/.aidev/bin/aidev-runner` · 로그 `~/.aidev/runner.log`

제한해서 설치:

```bash
curl -fsSL https://dev.nado.work/_runner/scripts/install-macos.sh | bash -s -- --code <코드> --limited --logon-only
```

## Linux · 라즈베리 파이 (x64, ARM64, ARMv7 자동 선택)

터미널 또는 SSH

```bash
curl -fsSL https://dev.nado.work/_runner/scripts/install-linux.sh | bash -s -- --code <코드>
```

- **sudo 비밀번호**를 한 번 묻습니다. 로그인하지 않아도 부팅 때 실행(linger)과 관리자 권한 설정에 씁니다.
- 데스크톱에 로그인하면 세션 러너가 연결을 넘겨받아 화면·원격 제어·트레이 아이콘까지 동작합니다 (KDE, XFCE, GNOME + AppIndicator 확장).
- systemd가 없는 환경(컨테이너, WSL)은 백그라운드 실행 + cron `@reboot`로 등록됩니다.

이 CPU용 바이너리가 없을 때 — 그 PC에서 소스로 빌드:

```bash
curl -fsSL https://dev.nado.work/_runner/source/aidev-runner-src.tar.gz | tar -xz && ./aidev-runner-src/scripts/build-linux.sh --install --code <코드>
```

제한해서 설치:

```bash
curl -fsSL https://dev.nado.work/_runner/scripts/install-linux.sh | bash -s -- --code <코드> --limited --logon-only
```

> **Android · iPhone**에는 러너를 설치하지 않습니다. 휴대폰이나 에뮬레이터를 연결한 PC의 러너가 adb·Xcode로 다룹니다.

## 다시 설치 (서비스만 지운 뒤, 페어링은 그대로)

`uninstall`이나 설치 스크립트의 `--uninstall`(Windows `-Uninstall`)은 서비스만 지웁니다. 러너 파일과 페어링은 남아 있으므로 코드 없이 다시 설치할 수 있습니다.

**방법 1 · 남아 있는 러너로 바로 (가장 빠름)**

```powershell
# Windows (PowerShell)
& "$HOME\.aidev\bin\aidev-runner.exe" install
```

```bash
# macOS · Linux
~/.aidev/bin/aidev-runner install
```

처음 설치와 같이 부팅 직후부터, 관리자 권한으로 등록합니다(Windows UAC 한 번, macOS·Linux sudo 비밀번호 한 번). 제한하려면 뒤에 `--limited --logon-only`.

**방법 2 · 설치 스크립트를 코드 없이 (최신 버전으로 바꾸면서)**

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://dev.nado.work/_runner/scripts/install-windows.ps1)))
```

```bash
# macOS
curl -fsSL https://dev.nado.work/_runner/scripts/install-macos.sh | bash
# Linux · 라즈베리 파이
curl -fsSL https://dev.nado.work/_runner/scripts/install-linux.sh | bash
```

**페어링까지 처음부터 (다른 계정에 연결하거나 대상을 지웠을 때)**

PC에서 토큰을 지운 뒤, 작업대 원격 대상(또는 휴대폰 PC 연결)에서 새 코드를 받아 위 OS별 설치 줄을 `--code`(Windows `-Code`)와 함께 실행합니다.

```powershell
# Windows
& "$HOME\.aidev\bin\aidev-runner.exe" uninstall; & "$HOME\.aidev\bin\aidev-runner.exe" unpair
```

```bash
# macOS · Linux
~/.aidev/bin/aidev-runner uninstall; ~/.aidev/bin/aidev-runner unpair
```

작업대에서 예전 대상을 지우면 그 PC의 연결은 즉시 끊깁니다.

## 업데이트

이미 연결된 PC: 코드 없이 같은 줄. 페어링과 허용 설정은 그대로 유지됩니다.

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://dev.nado.work/_runner/scripts/install-windows.ps1)))
```

```bash
# macOS
curl -fsSL https://dev.nado.work/_runner/scripts/install-macos.sh | bash
# Linux
curl -fsSL https://dev.nado.work/_runner/scripts/install-linux.sh | bash
```

## 제거

서비스·부팅 실행·관리자 권한 설정을 모두 지웁니다(페어링은 유지).

```powershell
# Windows
& "$HOME\.aidev\bin\aidev-runner.exe" uninstall
```

```bash
# macOS · Linux
~/.aidev/bin/aidev-runner uninstall
```

연결까지 끊으려면 이어서 `unpair`를 실행하고 작업대 원격 대상에서도 그 PC를 삭제하세요.

## 러너 명령

설치 스크립트 없이 받은 실행 파일을 직접 쓸 때. `install`은 자신을 `~/.aidev/bin`(Windows `%USERPROFILE%\.aidev\bin`)에 복사해 등록하므로 받은 파일은 지워도 됩니다(러너 0.13.5부터).

| 명령 | 하는 일 |
|---|---|
| `aidev-runner` | 포그라운드 실행. 처음이면 페어링 코드를 묻습니다. Windows는 더블클릭해도 됩니다. |
| `aidev-runner install` | 서비스 설치: 부팅 직후부터, 관리자 권한으로 실행. |
| `aidev-runner install --limited --logon-only` | 일반 사용자 권한, 로그인한 동안만. |
| `aidev-runner uninstall` | 서비스 제거. |
| `aidev-runner status` | 연결 대상·허용 폴더·화면 허용 상태. |
| `aidev-runner consent screen off` | 화면 보기 끄기 (`control off`는 원격 제어만). 처음엔 둘 다 켜져 있습니다. |
| `aidev-runner pair <코드>` | 다시 페어링. |
| `aidev-runner unpair` | 이 PC의 토큰 삭제. |

화면이 있는 OS에서는 아이콘 메뉴로 **시작 · 정지 · 종료**를 할 수 있습니다. 정지하면 연결이 끊기고 실행 중인 명령이 멈추며, 종료하면 다시 실행할 때까지 꺼져 있습니다.
