#!/bin/bash
# Mac: put the newest built runner in place and restart it — building (./runner/build.sh) only writes
# ops/runner/dist/; the runner that is connected keeps running its old binary until this replaces it.
#   ./runner/install.sh                 # newest version in ops/runner/dist
#   ./runner/install.sh 0.7.0           # a specific version
# The runner lives at ~/.aidev/bin/aidev-runner (one fixed path, so macOS permissions and the LaunchAgent
# keep pointing at it) and runs as the LaunchAgent work.nado.aidev-runner. Pairing and consent settings
# (~/.aidev/runner.toml) are kept.
set -euo pipefail
OPS=$(cd "$(dirname "$0")/.." && pwd)
DIST="$OPS/runner/dist"
DEST="$HOME/.aidev/bin/aidev-runner"
[ "$(uname -s)" = Darwin ] || { echo "macOS 전용입니다"; exit 1; }
arch=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)
ver=${1:-$(ls "$DIST" | sed -n "s/^aidev-runner-\(.*\)-mac-$arch$/\1/p" | sort -V | tail -1)}
SRC="$DIST/aidev-runner-$ver-mac-$arch"
[ -n "$ver" ] && [ -f "$SRC" ] || { echo "$DIST 에 mac-$arch 러너가 없습니다 — 먼저 ./runner/build.sh mac"; exit 1; }

old=""; [ -x "$DEST" ] && old=$("$DEST" --version 2>/dev/null | awk '{print $2}')
plist="$HOME/Library/LaunchAgents/work.nado.aidev-runner.plist"
[ -f "$plist" ] && echo "현재 서비스 실행 파일: $(plutil -extract ProgramArguments.0 raw "$plist" 2>/dev/null || echo '?')"
echo "==> 설치: $SRC → $DEST (${old:-없음} → $ver)"

# stop what runs now: the service and any runner started by hand in a terminal (only one may be connected)
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
pkill -f 'aidev-runner[^ ]* start' 2>/dev/null && sleep 1 || true

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST.new" && chmod 755 "$DEST.new"
xattr -c "$DEST.new" 2>/dev/null || true
# ad-hoc signature with a fixed identifier (the linker's signature does not survive every copy/lipo)
codesign --force --sign - --identifier work.nado.aidev-runner "$DEST.new" >/dev/null 2>&1 || true
mv -f "$DEST.new" "$DEST"
echo "==> $("$DEST" --version)"

if ! "$DEST" status >/dev/null 2>&1; then
  # not paired yet (a new PC): the service can only start once this PC has its token
  cat <<EOF

설치했습니다. 이 PC는 아직 페어링되지 않았습니다 — 작업대 "원격 대상"에서 대상을 만들고 카드의 명령을 실행하세요:
    $DEST pair <페어링 코드> --gateway https://dev.nado.work
    $DEST install-service
EOF
  exit 0
fi
"$DEST" install-service      # LaunchAgent → $DEST start (at login and now)
sleep 3
"$DEST" status || true
cat <<EOF

완료. 작업대 "원격 대상"에서 러너 버전이 $ver 로 바뀌었는지 확인하세요.
- 화면 보기·원격 제어는 한 번 허용해야 합니다(설정은 유지됨):
    $DEST consent screen on     # 또는  consent control on  (제어 포함)
    launchctl kickstart -k gui/$(id -u)/work.nado.aidev-runner    # 설정 바꾼 뒤 재시작
- macOS 권한(시스템 설정 → 개인정보 보호 및 보안): 화면 기록, 손쉬운 사용에 $DEST 허용.
  러너 파일이 바뀌면 macOS가 이전 허용을 인정하지 않을 수 있습니다 — 목록에서 지우고(−) 다시 추가(+)하세요.
- 로그: ~/.aidev/runner.log
EOF
