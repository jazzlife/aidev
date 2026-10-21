# NadoVibe 러너 — Android 앱

Android 기기(휴대폰·태블릿·TV 박스·산업용 패널 등, Android 7.0 이상)에서 원격 러너(`aidev-runner`)를 상시 실행하는 앱입니다.
러너 자체는 데스크톱과 같은 Rust 프로그램(`deploy/aidev/runner`)이고, 앱은 그것을 ABI별로 담아 **포그라운드 서비스**로 돌립니다.

| 구성 | 하는 일 |
|---|---|
| `RunnerService` | `aidev-runner start --service`를 자식 프로세스로 실행·감시. 끝나면 5초(→60초) 뒤 다시 실행, 토큰 거부(exit 3)면 멈추고 다시 페어링을 요청. 알림에 연결 상태와 **정지** 버튼. 정지는 SIGTERM → 러너가 실행 중인 명령을 끝내고 종료. CPU·Wi-Fi 깨어 있기(설정). |
| `BootReceiver` | 부팅 후(설정이 켜져 있으면)와 앱 업데이트 후 서비스를 다시 시작 |
| `MainActivity` | 상태(연결됨·연결 중·꺼짐)와 시작·정지·다시 시작, **권한 목록**(✓/✗ + 허용 버튼), 페어링, 업데이트 확인, 러너 로그 |

권한 목록 — 각 항목의 "허용"이 권한 요청 또는 해당 시스템 설정 화면을 엽니다(없는 기기는 앱 정보 화면으로):

- **알림** (Android 13+) — 연결 상태 알림. 없어도 서비스는 돌지만 사용자에게 보이지 않습니다.
- **배터리 최적화 제외** — 절전(Doze) 중에도 연결 유지.
- **백그라운드 데이터** — 데이터 절약 모드에서도 연결 유지.
- **저장소 전체 접근** — 허용하면 `/storage/emulated/0`을 러너의 허용 폴더에 추가하고 러너를 다시 시작합니다.
- 부팅 시 자동 시작, 화면이 꺼져도 깨어 있기(스위치), 제조사 자동 실행 설정(앱 정보).

러너가 쓰는 곳: `HOME` = 앱의 files 폴더(설정 `files/.aidev/runner.toml`, 로그 `files/.aidev/runner.log`, 상태 `files/.aidev/state`),
셸 `/system/bin/sh`. Android에서는 화면 보기·원격 제어를 제공하지 않습니다(러너가 capabilities에서 뺌).

## 페어링

작업대 **원격 대상 → 등록**(휴대폰 **PC 연결 → +**)에서 OS를 **Android**로 고르면 APK 주소와 링크가 나옵니다.
`nadovibe-runner://pair?code=<코드>&gateway=<주소>` 링크를 그 기기에서 열면 앱의 입력란이 채워집니다.

## 빌드

```bash
deploy/aidev/runner/scripts/build-android.sh            # arm64-v8a, armeabi-v7a, x86_64 + APK → runner/dist/aidev-runner-<버전>-android.apk
deploy/aidev/runner/scripts/build-android.sh --abi arm64-v8a   # 빠른 시험 빌드
```

필요: Rust, Android NDK(`ANDROID_NDK_HOME` 또는 `$ANDROID_HOME/ndk`의 최신), Android SDK(`ANDROID_HOME`), JDK 17+.
러너는 API 24로 링크하고 C++ 런타임(OpenH264)을 정적으로 넣습니다 — 앱 안의 프로그램은 `libc++_shared.so`를 찾지 못합니다.
앱 버전은 러너 버전(`runner/Cargo.toml`)과 같습니다.

## 서명 키 (릴리스)

Android는 **같은 키로 서명한 APK만** 설치된 앱 위로 업데이트합니다. 릴리스는 항상 같은 키로 서명해야 합니다.

앱의 키는 2026-10-21에 만들었습니다 — 인증서 SHA-256 `54a11621e5226e51052b5e0b1a069b9e7f9f527b9b4465ac980bee2a63e0d6b6`
(`CN=NadoVibe Runner, O=NadoVibe`, RSA 4096, alias `nadovibe`, 100년). 릴리스 키로 빌드했는데 APK의 인증서가 이 값이 아니면
`build-android.sh`가 APK를 지우고 실패합니다(`release_cert` — 키 파일이 없으면 Gradle은 조용히 debug 키로 서명합니다).

- 로컬: `~/.nadovibe/android-signing/`(`nadovibe-runner.jks`, `password`, `alias`, 권한 600)을 `build-android.sh`가 기본으로 씁니다.
  `AIDEV_ANDROID_KEYSTORE`(+ `_PASSWORD`, `_KEY_ALIAS`)가 있으면 그것이 우선. 둘 다 없으면 debug 키로 서명합니다(시험용).
- CI: GitHub secret `ANDROID_KEYSTORE_B64`·`ANDROID_KEYSTORE_PASSWORD`·`ANDROID_KEY_ALIAS`. `runner-v*` 태그 빌드는 secret이 없으면 멈춥니다.

secret은 다시 읽을 수 없으므로 원본은 `~/.nadovibe/android-signing/`뿐입니다 — **잃어버리면 설치된 앱을 지우고 다시 깔아야** 합니다.
따로 백업하고, 키 파일은 저장소에 넣지 마세요. secret을 다시 넣을 때:

```bash
d=~/.nadovibe/android-signing
base64 -i $d/nadovibe-runner.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_B64
tr -d '\n' < $d/password | gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body nadovibe
```
