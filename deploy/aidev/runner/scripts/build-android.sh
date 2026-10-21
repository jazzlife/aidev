#!/usr/bin/env bash
# Android: the runner for each ABI (Android NDK, API 24 = Android 7.0) packaged into the NadoVibe 러너 app
# (deploy/aidev/android) → dist/aidev-runner-<version>-android.apk (+ SHA256SUMS). The gateway serves it at
# /_runner/download like the other runners; the app keeps the runner running as a foreground service.
#   scripts/build-android.sh                         # arm64-v8a, armeabi-v7a, x86_64 + the APK
#   scripts/build-android.sh --abi arm64-v8a         # one ABI (a quick test build)
#   scripts/build-android.sh --no-apk                # the runner binaries only (app/build/jni/<abi>/)
#   scripts/build-android.sh --check                 # only check the tools
# Needs: Rust (+ rustup targets, added here), the Android NDK (ANDROID_NDK_HOME, or the newest under
# $ANDROID_HOME/ndk), the Android SDK (ANDROID_HOME) and JDK 17+ for Gradle. Release signing: AIDEV_ANDROID_KEYSTORE
# (+ AIDEV_ANDROID_KEYSTORE_PASSWORD, AIDEV_ANDROID_KEY_ALIAS) — see deploy/aidev/android/app/build.gradle.kts —
# or, when unset, ~/.nadovibe/android-signing (nadovibe-runner.jks, password, alias). A release-signed APK must carry
# the app's certificate (release_cert below), or the build fails: Android refuses an update signed with another key.
set -euo pipefail
release_cert=54a11621e5226e51052b5e0b1a069b9e7f9f527b9b4465ac980bee2a63e0d6b6
keys="$HOME/.nadovibe/android-signing"
if [ -z "${AIDEV_ANDROID_KEYSTORE:-}" ] && [ -f "$keys/nadovibe-runner.jks" ]; then
  export AIDEV_ANDROID_KEYSTORE="$keys/nadovibe-runner.jks"
  AIDEV_ANDROID_KEYSTORE_PASSWORD=$(cat "$keys/password"); export AIDEV_ANDROID_KEYSTORE_PASSWORD
  AIDEV_ANDROID_KEY_ALIAS=$(cat "$keys/alias" 2>/dev/null || echo nadovibe); export AIDEV_ANDROID_KEY_ALIAS
fi
here=$(cd "$(dirname "$0")" && pwd); src=$(cd "$here/.." && pwd); app=$(cd "$src/../android" && pwd)
abis="arm64-v8a armeabi-v7a x86_64"; apk=1; check=0
while [ $# -gt 0 ]; do
  case $1 in
    --abi) abis=${2:?}; abis=${abis//,/ }; shift ;;
    --no-apk) apk=0 ;;
    --check) check=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
API=24
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
for d in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do [ -z "$sdk" ] && [ -d "$d" ] && sdk=$d; done
ndk=${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_NDK_LATEST_HOME:-}}}
if [ -z "$ndk" ] && [ -n "$sdk" ] && [ -d "$sdk/ndk" ]; then ndk=$(ls -d "$sdk"/ndk/*/ 2>/dev/null | sort -V | tail -1); ndk=${ndk%/}; fi
case $(uname -s) in Darwin) host=darwin-x86_64 ;; Linux) host=linux-x86_64 ;; *) echo "Linux 또는 macOS에서 빌드하세요"; exit 1 ;; esac
tc="$ndk/toolchains/llvm/prebuilt/$host/bin"
missing=()
[ -n "$ndk" ] && [ -x "$tc/clang" ] || missing+=("Android NDK: Android Studio SDK Manager → NDK, 또는 sdkmanager 'ndk;29.0.14206865' (ANDROID_NDK_HOME로 지정 가능)")
command -v cargo >/dev/null || missing+=("Rust: https://rustup.rs")
if [ $apk = 1 ]; then
  [ -n "$sdk" ] && [ -d "$sdk/platforms" ] || missing+=("Android SDK (ANDROID_HOME)")
  java -version 2>&1 | grep -qE 'version "(1[7-9]|2[0-9])' || missing+=("JDK 17 이상 (JAVA_HOME)")
fi
if [ ${#missing[@]} -gt 0 ]; then echo "빌드에 필요한 것이 없습니다:"; printf '  - %s\n' "${missing[@]}"; exit 1; fi
[ $check = 1 ] && { echo "도구 준비됨: NDK $(basename "$ndk"), $(rustc --version)"; exit 0; }

ver=$(sed -n 's/^version = "\(.*\)"/\1/p' "$src/Cargo.toml" | head -1)
cd "$src"
for abi in $abis; do
  case $abi in
    arm64-v8a)   target=aarch64-linux-android;   clang=aarch64-linux-android$API-clang ;;
    armeabi-v7a) target=armv7-linux-androideabi; clang=armv7a-linux-androideabi$API-clang ;;
    x86_64)      target=x86_64-linux-android;    clang=x86_64-linux-android$API-clang ;;
    *) echo "지원하지 않는 ABI: $abi (arm64-v8a, armeabi-v7a, x86_64)"; exit 1 ;;
  esac
  rustup target list --installed 2>/dev/null | grep -qx "$target" || rustup target add "$target"
  t=$(echo "$target" | tr '[:lower:]-' '[:upper:]_'); u=${target//-/_}
  echo "==> aidev-runner $ver android $abi ($target)"
  # the C++ runtime (OpenH264 is C++) linked in: a program cannot load the NDK's libc++_shared.so from the app —
  # the cc crate adds no C++ library of its own; the static libc++ and libc++abi go last (rustc links -nodefaultlibs)
  env "CC_$u=$tc/$clang" "CXX_$u=$tc/$clang++" "AR_$u=$tc/llvm-ar" "CXXSTDLIB_$u=" \
    "CARGO_TARGET_${t}_LINKER=$tc/$clang" "CARGO_TARGET_${t}_RUSTFLAGS=-C link-arg=-lc++_static -C link-arg=-lc++abi" \
    cargo build --release --locked --target "$target"
  mkdir -p "$app/app/build/jni/$abi"
  cp "target/$target/release/aidev-runner" "$app/app/build/jni/$abi/libaidevrunner.so"
done
[ $apk = 1 ] || { echo "==> $app/app/build/jni"; exit 0; }

echo "==> NadoVibe 러너 앱 $ver (Gradle)"
# only the ABIs built this time
find "$app/app/build/jni" -mindepth 1 -maxdepth 1 -type d | while read -r d; do case " $abis " in *" $(basename "$d") "*) ;; *) rm -rf "$d" ;; esac; done
(cd "$app" && ANDROID_HOME=$sdk ./gradlew --no-daemon -q assembleRelease)
mkdir -p dist
out="dist/aidev-runner-$ver-android.apk"
cp "$app/app/build/outputs/apk/release/app-release.apk" "$out"
if [ -n "${AIDEV_ANDROID_KEYSTORE:-}" ]; then
  # Gradle signs with the debug key when the keystore file is missing — check the certificate the APK carries
  apksigner="$(ls -d "$sdk"/build-tools/*/ | sort -V | tail -1)apksigner"
  # every signer line ("Signer #1 certificate …" up to build-tools 36, "V2 Signer: certificate …" from 37) — one key only
  certs=$("$apksigner" verify --print-certs "$out")
  cert=$(echo "$certs" | sed -n 's/.*certificate SHA-256 digest: //p' | sort -u | tr '\n' ' ' | sed 's/ $//')
  [ "$cert" = "$release_cert" ] || { rm -f "$out"; echo "$certs"; echo "APK가 앱의 릴리스 키로 서명되지 않았습니다: 인증서 ${cert:-없음}, 기대 $release_cert"; exit 1; }
  echo "==> 릴리스 키로 서명됨 ($release_cert)"
else
  echo "경고: 릴리스 키 없음 — debug 키로 서명 (시험용, 설치된 앱 위로 업데이트되지 않음)"
fi
name=$(basename "$out")
sums() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(cd dist && { grep -v "  $name\$" SHA256SUMS 2>/dev/null || true; sums "$name"; } | sort -k2 > SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS)
ls -la "$out"
