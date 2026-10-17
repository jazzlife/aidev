#!/usr/bin/env bash
# Linux: install aidev-runner at ~/.aidev/bin/aidev-runner, pair it (with a code from the workbench "원격 대상"
# card) and keep it running with the runner's own `install`: the systemd user service on a desktop or server; as root or
# without systemd (embedded boards: OpenRC, OpenWrt's procd, SysV / BusyBox init) a system service; with neither, cron.
# A system without glibc 2.28 (Alpine, Buildroot, OpenWrt, old images) gets the static musl build (linux-<arch>-musl).
# Without bash or curl (BusyBox): download the file with wget and run `aidev-runner menu` (pair, install, rights).
#   install-linux.sh --code <페어링 코드> [--gateway https://dev.nado.work] [--name NAME]   # download + pair + start
#   install-linux.sh --file dist/aidev-runner-0.9.0-linux-arm64 [--code …]            # a binary built here
#   install-linux.sh --dist <dir>        # the newest linux-<arch> build in that folder
#   install-linux.sh --no-service        # only put the binary in place
#   install-linux.sh --uninstall         # stop and remove the service (the pairing is kept)
#   install-linux.sh … --limited --logon-only   # restrict the default (administrator rights via passwordless sudo,
#                                               # running from boot via linger); the default asks for the sudo password once
# Without --file/--dist the binary comes from the gateway (/_runner/download) and its SHA-256 is checked.
# Also served by the gateway: curl -fsSL <gateway>/_runner/scripts/install-linux.sh | bash -s -- --code <코드>
set -euo pipefail
DEST="$HOME/.aidev/bin/aidev-runner"
file=""; dist=""; code=""; gateway=""; name=""; service=1; uninstall=0; svc_flags=()
while [ $# -gt 0 ]; do
  case $1 in
    --file) file=${2:?}; shift ;;
    --dist) dist=${2:?}; shift ;;
    --code) code=${2:?}; shift ;;
    --gateway) gateway=${2:?}; shift ;;
    --name) name=${2:?}; shift ;;
    --no-service) service=0 ;;
    --uninstall) uninstall=1 ;;
    --limited|--logon-only) svc_flags+=("$1") ;;
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
# musl (Alpine, OpenWrt, Buildroot …) or a glibc older than 2.28: only the static musl build runs
libc=gnu
if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then libc=musl
else gv=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}'); [ -n "$gv" ] && [ "$(printf '%s\n2.28\n' "$gv" | sort -V | head -1)" = 2.28 ] || libc=musl; fi
# the builds to look for, in order: glibc systems take either (the musl one is static)
if [ $libc = musl ]; then want="linux-$arch-musl"; else want="linux-$arch linux-$arch-musl"; fi

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
  [ -x "$DEST" ] && "$DEST" uninstall 2>/dev/null || true
  if command -v crontab >/dev/null; then (crontab -l 2>/dev/null | grep -vE 'aidev-runner.* (start|supervise)' || true) | crontab - 2>/dev/null || true; fi
  echo "서비스를 멈추고 등록을 지웠습니다 (페어링은 ~/.aidev/runner.toml 에 남아 있습니다 — 지우려면 $DEST unpair)"; exit 0
fi

# ---- the binary ----------------------------------------------------------------------------------------
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ -z "$file" ] && [ -n "$dist" ]; then
  for w in $want; do file=$(ls "$dist"/aidev-runner-*-$w 2>/dev/null | sort -V | tail -1 || true); [ -n "$file" ] && break; done
  [ -n "$file" ] || { echo "$dist 에 ${want// / 또는 } 러너가 없습니다 — scripts/build-linux.sh 로 빌드하세요"; exit 1; }
fi
if [ -z "$file" ]; then
  if [ -z "$gateway" ] && [ -f "$HOME/.aidev/runner.toml" ]; then gateway=$(sed -n 's/^gateway *= *"\(.*\)"/\1/p' "$HOME/.aidev/runner.toml" | head -1); fi
  gateway=${gateway:-https://dev.nado.work}; gateway=${gateway%/}
  command -v curl >/dev/null || { echo "curl이 필요합니다"; exit 1; }
  list=$(curl -fsSL "$gateway/_runner/download") || { echo "$gateway 에서 러너 목록을 받지 못했습니다"; exit 1; }
  pick=""; for w in $want; do pick=$(printf '%s' "$list" | tr '{' '\n' | grep "\"platform\":\"$w\"" | tail -1 || true); [ -n "$pick" ] && break; done
  fname=$(printf '%s' "$pick" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  sha=$(printf '%s' "$pick" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
  if [ -z "$fname" ]; then
    echo "이 서버에는 ${want// / · } 러너 바이너리가 없습니다 — 이 기기에서 빌드하세요:"
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
[ $service = 1 ] || { echo "설치만 했습니다 (--no-service). 실행: $DEST   (서비스 설치: $DEST install)"; exit 0; }

# ---- keep it running -----------------------------------------------------------------------------------
logf="$HOME/.aidev/runner.log"
since=$(date +%s)
# the runner's own `install`: the systemd user service (from boot by linger), else a system service (root, OpenRC,
# procd, SysV) or cron — and passwordless sudo unless restricted
# (an older install's cron line that started `start` directly: the runner's own registration replaces it)
if command -v crontab >/dev/null; then (crontab -l 2>/dev/null | grep -v 'aidev-runner" start' || true) | crontab - 2>/dev/null || true; fi
"$DEST" install ${svc_flags[@]+"${svc_flags[@]}"}
user_unit() { [ -f "$HOME/.config/systemd/user/aidev-runner.service" ]; }

# ---- verify --------------------------------------------------------------------------------------------
ok=0
for _ in $(seq 1 20); do
  if pgrep -u "$(id -u)" -f "$DEST start" >/dev/null; then
    line=""
    if user_unit; then line=$(journalctl --user -u aidev-runner --since "@$since" --no-pager 2>/dev/null | grep '연결됨' | tail -1 || true); fi
    [ -z "$line" ] && [ -f "$logf" ] && line=$(grep '연결됨' "$logf" | tail -1 || true)
    [ -n "$line" ] && { ok=1; break; }
  fi
  sleep 1
done
if [ $ok = 1 ]; then echo " ✓ 실행 중이고 플랫폼에 연결됨: ${line##*연결됨: }"
elif pgrep -u "$(id -u)" -f "$DEST start" >/dev/null; then echo " ! 실행 중이지만 20초 안에 연결 기록을 못 봤습니다 — 로그: $(user_unit && echo 'journalctl --user -u aidev-runner -f' || echo "$logf")"
else echo " ✗ 러너가 실행되지 않았습니다 — 로그: $(user_unit && echo 'journalctl --user -u aidev-runner -n 50' || echo "$logf")"; exit 1; fi
echo "- 새 터미널부터 어디서든 aidev-runner — 관리 메뉴(권한·서비스·로그): aidev-runner menu — 업데이트: 트레이 아이콘의 \"업데이트\" 또는 aidev-runner update"
