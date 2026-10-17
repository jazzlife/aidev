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

## macOS (13 Ventura 이상)

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

## 임베디드 Linux (Alpine, Buildroot, OpenWrt, Yocto, 라즈베리 파이 등)

위 Linux 설치 줄이 그대로 동작합니다. 설치 스크립트가 glibc가 없거나(musl) 2.28보다 오래된 시스템이면 **정적 musl 빌드**
(`linux-x64-musl` · `linux-arm64-musl` · `linux-armv7-musl`)를 고르고, 러너의 `install`이 그 기기의 init에 맞춰 서비스로 등록합니다.

| 환경 | 등록되는 것 (부팅 때부터, 죽으면 다시 실행) |
|---|---|
| 데스크톱·서버 (일반 사용자 + systemd) | systemd 사용자 서비스 + linger (기존과 같음) |
| root로 설치 + systemd | `/etc/systemd/system/aidev-runner.service` |
| OpenRC (Alpine 등) | `/etc/init.d/aidev-runner` (`rc-update add … default`) |
| OpenWrt (procd) | `/etc/init.d/aidev-runner` (`enable`) |
| SysV · BusyBox init | `/etc/init.d/aidev-runner` (update-rc.d·chkconfig·rcN.d) 또는 BusyBox rcS의 `/etc/init.d/S99aidev-runner` |
| init에 등록할 수 없을 때 | cron `@reboot` + 지금 바로 실행 |

시스템 서비스는 설치한 계정으로 `aidev-runner supervise`를 실행합니다(러너가 비정상 종료하면 5초 뒤 다시 시작, 토큰 거부면 멈춤). 로그 `~/.aidev/runner.log`.

bash·curl이 없는 기기(BusyBox): 작업대 페어링 카드에서 OS를 `linux-…-musl`로 고르면 wget 줄이 나옵니다. 또는

```sh
mkdir -p ~/.aidev/bin && wget -qO ~/.aidev/bin/aidev-runner https://dev.nado.work/_runner/download/<파일 이름> && chmod +x ~/.aidev/bin/aidev-runner
~/.aidev/bin/aidev-runner menu        # 1) 페어링 → 서비스 설치 → 6) 권한
```

## 터미널 관리 메뉴 (화면이 없는 기기)

SSH나 시리얼 콘솔에서 `aidev-runner menu` — 서비스가 이미 설치된 기기에서는 `aidev-runner`만 쳐도 메뉴가 열립니다.

```
━━ NadoVibe 러너 0.19.0 · 관리 메뉴 (linux aarch64, board-01) ━━
  페어링     #42 board-01 → https://dev.nado.work
  서비스     OpenRC 서비스 · 연결됨 (pid 126)
  권한       빠짐 1개 — 장치: 시리얼 포트 (/dev/ttyUSB*, ttyACM*)
  …
  1) 페어링 (코드 입력)          2) 서비스 설치·다시 설치
  3) 시작                        4) 정지 (연결 끊기)
  5) 다시 시작                   6) 권한 확인·얻기
  7) 로그 보기                   8) 허용 폴더
  9) 화면 보기·원격 제어        10) 업데이트
 11) 서비스 제거                12) 페어링 해제
```

**권한 확인·얻기**(메뉴 6, 또는 `aidev-runner perms [--fix] [--json]`):

- **관리자 권한** — root이거나 비밀번호 없는 sudo(`/etc/sudoers.d/aidev-runner`). 얻기: sudo 비밀번호 한 번.
- **부팅 때 실행** — 시스템 서비스, 또는 systemd 사용자 서비스의 linger. 얻기: linger 켜기 / 서비스 설치.
- **장치 그룹** — 이 시스템에 있는 `dialout`·`tty`·`uucp`(시리얼), `plugdev`(USB), `gpio`·`i2c`·`spi`, `video`·`render`·`input`·`audio` 중
  빠진 것. 얻기: `usermod -aG`(BusyBox는 `adduser`/`addgroup`), 그다음 서비스를 다시 시작하면 러너에 적용됩니다.

같은 일을 명령으로: `aidev-runner service start|stop|restart|status`, `aidev-runner perms --fix`.

## Android

**NadoVibe 러너 앱**이 러너를 포그라운드 서비스로 상시 실행합니다 (Android 7.0 이상, 휴대폰·태블릿·TV 박스·산업용 패널).

1. 작업대 원격 대상 → 등록에서 OS를 **Android**로 고르고, 그 기기의 브라우저로 **APK 받기**(`/_runner/download/aidev-runner-<버전>-android.apk`) → 설치.
2. 앱에 페어링 코드와 게이트웨이를 넣고 **페어링** (그 기기에서 카드의 **앱에서 페어링 열기** 링크를 누르면 채워집니다).
3. 앱의 **권한** 목록에서 ✗ 항목을 **허용** — 알림, 배터리 최적화 제외, 백그라운드 데이터, 저장소 전체 접근(허용하면 `/storage/emulated/0`을 허용 폴더에 추가).
   **부팅 시 자동 시작**과 **화면이 꺼져도 깨어 있기**는 기본으로 켜져 있습니다.

알림에 연결 상태와 **정지**가 보입니다. 앱 업데이트는 앱의 **업데이트** 버튼(새 APK 받기 → 설치, 페어링·설정 유지).
Android에서는 명령 실행·파일 동기화·포트 터널 등이 동작하고, 화면 보기·원격 제어는 제공하지 않습니다.

> **iPhone**에는 러너를 설치하지 않습니다. 연결한 Mac의 러너가 Xcode(simctl)로 다룹니다.

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

**러너 0.14.0부터**

- **아이콘 메뉴**: 새 버전이 있으면 메뉴 막대·알림 영역·트레이 아이콘의 메뉴에 **"업데이트 — 0.x.y 있음…"**이 나타납니다. 누르면 버전 목록(최신과 이전 버전) 창이 뜨고, 고른 버전으로 바로 교체됩니다.
- **콘솔**: 같은 목록이 번호로 나옵니다. 번호를 고르거나(Enter = 최신) 버전을 바로 지정합니다.

```bash
aidev-runner update            # 목록에서 고르기
aidev-runner update latest     # 최신으로 바로
aidev-runner update 0.14.0     # 이 버전으로 (이전 버전으로 되돌리기도)
```

진행 과정:
1. 받은 파일의 SHA-256을 확인합니다.
2. 이 PC의 러너를 모두 멈춥니다(연결과 실행 중인 명령 중지).
3. `~/.aidev/bin`의 파일을 교체합니다. 이전 파일은 `aidev-runner.prev`로 남깁니다.
4. 각 러너가 같은 서비스·관리자 권한·데스크톱 세션으로 다시 시작합니다.

페어링·허용 설정·macOS 화면 기록 권한은 그대로입니다.

**0.13.x 이하에서 올릴 때**(또는 설치 스크립트로): 코드 없이 같은 줄. 페어링과 허용 설정은 그대로 유지됩니다.

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

설치 스크립트 없이 받은 실행 파일을 직접 쓸 때. `install`은 자신을 `~/.aidev/bin`(Windows `%USERPROFILE%\.aidev\bin`)에 복사해 등록하므로 받은 파일은 지워도 됩니다(러너 0.13.5부터). 그 폴더를 PATH에 등록하므로 새로 연 터미널 어디서든 `aidev-runner`로 실행됩니다(0.14.0부터 — Windows: 사용자 Path, macOS·Linux: 셸 시작 파일과 `/usr/local/bin`).

| 명령 | 하는 일 |
|---|---|
| `aidev-runner` | 포그라운드 실행. 처음이면 페어링 코드를 묻습니다. Windows는 더블클릭해도 됩니다. 서비스가 이미 돌고 있는 macOS·Linux 터미널에서는 관리 메뉴가 열립니다. |
| `aidev-runner install` | 서비스 설치: 부팅 직후부터, 관리자 권한으로 실행. |
| `aidev-runner install --limited --logon-only` | 일반 사용자 권한, 로그인한 동안만. |
| `aidev-runner uninstall` | 서비스 제거. |
| `aidev-runner update` | 받을 수 있는 버전(최신·이전) 목록에서 골라 교체. `update latest` · `update 0.14.0`으로 바로. |
| `aidev-runner status` | 연결 대상·허용 폴더·화면 허용 상태. |
| `aidev-runner consent screen off` | 화면 보기 끄기 (`control off`는 원격 제어만). 처음엔 둘 다 켜져 있습니다. |
| `aidev-runner pair <코드>` | 다시 페어링. |
| `aidev-runner unpair` | 이 PC의 토큰 삭제. |
| `aidev-runner menu` | 터미널 관리 메뉴: 상태·권한·페어링·서비스·로그·업데이트 (서비스가 설치된 기기에서 `aidev-runner`만 쳐도 열림). |
| `aidev-runner perms [--fix] [--json]` | 권한 확인 (`--fix`: 빠진 관리자 권한·부팅 실행·장치 그룹을 얻음). |
| `aidev-runner service start\|stop\|restart\|status` | 정지는 연결을 끊고 명령을 멈춤(아이콘의 정지와 같음), 시작은 다시 연결(서비스가 꺼져 있으면 켬). |

화면이 있는 OS에서는 아이콘 메뉴로 **시작 · 정지 · 종료**(새 버전이 있으면 **업데이트**도)를 할 수 있습니다. 정지하면 연결이 끊기고 실행 중인 명령이 멈추며, 종료하면 다시 실행할 때까지 꺼져 있습니다.
