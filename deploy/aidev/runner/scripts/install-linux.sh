#!/usr/bin/env bash
# Linux: install aidev-runner at ~/.aidev/bin/aidev-runner, pair it (with a code from the workbench "원격 대상"
# card) and keep it running — systemd user service, or where there is none (containers, WSL without systemd,
# minimal SBC images) a background process started again at boot by cron.
#   install-linux.sh --code <페어링 코드> [--gateway https://dev.nado.work] [--name NAME]   # download + pair + start
#   install-linux.sh --file dist/aidev-runner-0.9.0-linux-arm64 [--code …]            # a binary built here
#   install-linux.sh --dist <dir>        # the newest linux-<arch> build in that folder
#   install-linux.sh --no-service        # only put the binary in place
#   install-linux.sh --uninstall         # stop and remove the service (the pairing is kept)
# Without --file/--dist the binary comes from the gateway (/_runner/download) and its SHA-256 is checked.
# Also served by the gateway: curl -fsSL <gateway>/_runner/scripts/install-linux.sh | bash -s -- --code <코드>
set -euo pipefail
DEST="$HOME/.aidev/bin/aidev-runner"
file=""; dist=""; code=""; gateway=""; name=""; service=1; uninstall=0
while [ $# -gt 0 ]; do
  case $1 in
    --file) file=${2:?}; shift ;;
    --dist) dist=${2:?}; shift ;;
    --code) code=${2:?}; shift ;;
    --gateway) gateway=${2:?}; shift ;;
    --name) name=${2:?}; shift ;;
    --no-service) service=0 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Linux ] || { echo "Linux 전용입니다 (macOS: install-macos.sh, Windows: install-windows.ps1)"; exit 1; }
case $(uname -m) in
  x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; armv7l|armv7|armhf) arch=armv7 ;;
  *) echo "지원하지 않는 CPU: $(uname -m)"; exit 1 ;;
esac
has_systemd() { command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; }

# runners of this user that use this configuration (same HOME / AIDEV_RUNNER_HOME): they hold this PC's token
same_config_runners() {
  local want_home=${AIDEV_RUNNER_HOME:-} pid env
  for pid in $(pgrep -u "$(id -u)" -f 'aidev-runner[^ ]*( start|$)' 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    env=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null) || continue
    if [ -n "$want_home" ]; then printf '%s\n' "$env" | grep -qx "AIDEV_RUNNER_HOME=$want_home" || continue
    else printf '%s\n' "$env" | grep -q '^AIDEV_RUNNER_HOME=' && continue; printf '%s\n' "$env" | grep -qx "HOME=$HOME" || continue; fi
    echo "$pid"
  done
}
stop_running() {
  if has_systemd; then systemctl --user stop aidev-runner.service 2>/dev/null || true; fi
  # a runner started by hand or by the cron fallback: only one may be connected with this PC's token
  local pids; pids=$(same_config_runners)
  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; sleep 1; fi
}

if [ $uninstall = 1 ]; then
  stop_running
  [ -x "$DEST" ] && "$DEST" uninstall-service 2>/dev/null || true
  if command -v crontab >/dev/null; then (crontab -l 2>/dev/null | grep -v 'aidev-runner start' || true) | crontab - 2>/dev/null || true; fi
  echo "서비스를 멈추고 등록을 지웠습니다 (페어링은 ~/.aidev/runner.toml 에 남아 있습니다 — 지우려면 $DEST unpair)"; exit 0
fi

# ---- the binary ----------------------------------------------------------------------------------------
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ -z "$file" ] && [ -n "$dist" ]; then
  file=$(ls "$dist"/aidev-runner-*-linux-$arch 2>/dev/null | sort -V | tail -1 || true)
  [ -n "$file" ] || { echo "$dist 에 linux-$arch 러너가 없습니다 — scripts/build-linux.sh 로 빌드하세요"; exit 1; }
fi
if [ -z "$file" ]; then
  if [ -z "$gateway" ] && [ -f "$HOME/.aidev/runner.toml" ]; then gateway=$(sed -n 's/^gateway *= *"\(.*\)"/\1/p' "$HOME/.aidev/runner.toml" | head -1); fi
  gateway=${gateway:-https://dev.nado.work}; gateway=${gateway%/}
  command -v curl >/dev/null || { echo "curl이 필요합니다"; exit 1; }
  list=$(curl -fsSL "$gateway/_runner/download") || { echo "$gateway 에서 러너 목록을 받지 못했습니다"; exit 1; }
  pick=$(printf '%s' "$list" | tr '{' '\n' | grep "\"platform\":\"linux-$arch\"" | tail -1 || true)
  fname=$(printf '%s' "$pick" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  sha=$(printf '%s' "$pick" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
  if [ -z "$fname" ]; then
    echo "이 서버에는 linux-$arch 러너 바이너리가 없습니다 — 이 기기에서 빌드하세요:"
    echo "  curl -fsSL $gateway/_runner/source/aidev-runner-src.tar.gz | tar -xz && ./aidev-runner-src/scripts/build-linux.sh --install${code:+ --code $code} --gateway $gateway"
    exit 1
  fi
  echo "==> 내려받기: $gateway/_runner/download/$fname"
  curl -fsSL "$gateway/_runner/download/$fname" -o "$tmp/aidev-runner"
  got=$(sha256sum "$tmp/aidev-runner" | cut -d' ' -f1)
  [ -z "$sha" ] || [ "$got" = "$sha" ] || { echo "SHA-256이 다릅니다 (받음 $got, 목록 $sha) — 설치하지 않습니다"; exit 1; }
  file="$tmp/aidev-runner"
fi
[ -f "$file" ] || { echo "$file 이 없습니다"; exit 1; }
chmod 755 "$file"
new_ver=$("$file" --version 2>/dev/null | awk '{print $2}') || { echo "$file 을 실행하지 못했습니다 (CPU·glibc가 맞지 않음?)"; exit 1; }
old_ver=""; [ -x "$DEST" ] && old_ver=$("$DEST" --version 2>/dev/null | awk '{print $2}' || true)
echo "==> 설치: $DEST (${old_ver:-없음} → $new_ver)"
stop_running
mkdir -p "$(dirname "$DEST")"
cp "$file" "$DEST.new" && chmod 755 "$DEST.new" && mv -f "$DEST.new" "$DEST"

# ---- pairing -------------------------------------------------------------------------------------------
if [ -n "$code" ]; then
  args=(pair "$code"); [ -n "$gateway" ] && args+=(--gateway "$gateway"); [ -n "$name" ] && args+=(--name "$name")
  "$DEST" "${args[@]}"
fi
if ! "$DEST" status >/dev/null 2>&1; then
  echo; echo "설치했습니다. 이 PC는 아직 페어링되지 않았습니다 — 작업대 \"원격 대상\"에서 코드를 받아:"
  if [ -f "$0" ]; then echo "  $0 --code <페어링 코드>${gateway:+ --gateway $gateway}"
  else echo "  curl -fsSL ${gateway:-https://dev.nado.work}/_runner/scripts/install-linux.sh | bash -s -- --code <페어링 코드>"; fi
  exit 0
fi
[ $service = 1 ] || { echo "설치만 했습니다 (--no-service). 실행: $DEST   (서비스로: $DEST service)"; exit 0; }

# ---- keep it running -----------------------------------------------------------------------------------
logf="$HOME/.aidev/runner.log"
since=$(date +%s)
if has_systemd; then
  "$DEST" install-service
  # a headless machine (SBC, server): keep the user's services running without a login session
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
    loginctl enable-linger "$USER" 2>/dev/null && echo " ✓ 로그인하지 않아도 계속 실행 (linger)" || echo " ! 로그아웃하면 멈춥니다 — 계속 돌리려면: sudo loginctl enable-linger $USER"
  fi
else
  echo "==> systemd 사용자 서비스를 쓸 수 없어 백그라운드로 실행하고 부팅 시 다시 시작하도록 등록합니다 (cron @reboot)"
  mkdir -p "$(dirname "$logf")"
  nohup setsid "$DEST" start >> "$logf" 2>&1 < /dev/null &
  if command -v crontab >/dev/null; then
    { crontab -l 2>/dev/null | grep -v 'aidev-runner start' || true; echo "@reboot \"$DEST\" start >> \"$logf\" 2>&1"; } | crontab - && echo " ✓ cron @reboot 등록" || echo " ! crontab 등록 실패 — 재부팅 후에는 $DEST start 를 직접 실행하세요"
  else
    echo " ! cron이 없습니다 — 재부팅 후에는 $DEST start 를 직접 실행하세요"
  fi
fi

# ---- verify --------------------------------------------------------------------------------------------
ok=0
for _ in $(seq 1 20); do
  if pgrep -u "$(id -u)" -f "$DEST start" >/dev/null; then
    line=""
    if has_systemd; then line=$(journalctl --user -u aidev-runner --since "@$since" --no-pager 2>/dev/null | grep '연결됨' | tail -1 || true); fi
    [ -z "$line" ] && [ -f "$logf" ] && line=$(grep '연결됨' "$logf" | tail -1 || true)
    [ -n "$line" ] && { ok=1; break; }
  fi
  sleep 1
done
if [ $ok = 1 ]; then echo " ✓ 실행 중이고 플랫폼에 연결됨: ${line##*연결됨: }"
elif pgrep -u "$(id -u)" -f "$DEST start" >/dev/null; then echo " ! 실행 중이지만 20초 안에 연결 기록을 못 봤습니다 — 로그: $(has_systemd && echo 'journalctl --user -u aidev-runner -f' || echo "$logf")"
else echo " ✗ 러너가 실행되지 않았습니다 — 로그: $(has_systemd && echo 'journalctl --user -u aidev-runner -n 50' || echo "$logf")"; exit 1; fi
