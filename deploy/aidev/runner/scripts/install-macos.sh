#!/bin/bash
# macOS: install aidev-runner at ~/.aidev/bin/aidev-runner (one fixed path, so macOS permissions and the
# LaunchAgent keep pointing at it), pair it and (re)start it as the LaunchAgent work.nado.aidev-runner.
#   install-macos.sh --dist <dir> [--version 0.9.0]   # the newest (or that) mac build in a folder (ops/runner/dist)
#   install-macos.sh --file <binary>                   # one binary
#   install-macos.sh --code <페어링 코드> [--gateway URL] [--name NAME]   # without --file/--dist: download from the gateway
#   install-macos.sh --no-service | --uninstall
#   install-macos.sh … --limited --logon-only   # restrict the default (administrator rights via passwordless sudo, from
#                                                # boot via a LaunchDaemon); the default asks for the sudo password once
# Pairing and consent settings (~/.aidev/runner.toml) are kept. ops/runner/install.sh calls this.
set -euo pipefail
DEST="$HOME/.aidev/bin/aidev-runner"
file=""; dist=""; version=""; code=""; gateway=""; name=""; service=1; uninstall=0; svc_flags=()
while [ $# -gt 0 ]; do
  case $1 in
    --file) file=${2:?}; shift ;;
    --dist) dist=${2:?}; shift ;;
    --version) version=${2:?}; shift ;;
    --code) code=${2:?}; shift ;;
    --gateway) gateway=${2:?}; shift ;;
    --name) name=${2:?}; shift ;;
    --no-service) service=0 ;;
    --uninstall) uninstall=1 ;;
    --limited|--logon-only) svc_flags+=("$1") ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Darwin ] || { echo "macOS 전용입니다 (Linux: install-linux.sh, Windows: install-windows.ps1)"; exit 1; }
arch=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)
uid=$(id -u); label="gui/$uid/work.nado.aidev-runner"
plist="$HOME/Library/LaunchAgents/work.nado.aidev-runner.plist"

stop_running() {
  launchctl bootout "gui/$uid" "$plist" 2>/dev/null || true
  # a runner started by hand in a terminal: only one may be connected with this PC's token
  pkill -f 'aidev-runner[^ ]*( start|$)' 2>/dev/null && sleep 1 || true
}
if [ $uninstall = 1 ]; then
  if [ -x "$DEST" ]; then "$DEST" uninstall || true; fi
  stop_running; rm -f "$plist"
  echo "서비스를 멈추고 지웠습니다 (페어링은 유지 — 지우려면 $DEST unpair)"; exit 0
fi

# ---- the binary ----------------------------------------------------------------------------------------
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ -z "$file" ] && [ -n "$dist" ]; then
  ver=${version:-$(ls "$dist" | sed -En "s/^aidev-runner-(.*)-mac-($arch|universal)$/\1/p" | sort -V | tail -1)}
  for cand in "$dist/aidev-runner-$ver-mac-$arch" "$dist/aidev-runner-$ver-mac-universal"; do [ -f "$cand" ] && { file=$cand; break; }; done
  [ -n "$file" ] || { echo "$dist 에 mac-$arch 러너가 없습니다 — 먼저 scripts/build-macos.sh (ops: ./runner/build.sh mac)"; exit 1; }
fi
if [ -z "$file" ]; then
  if [ -z "$gateway" ] && [ -f "$HOME/.aidev/runner.toml" ]; then gateway=$(sed -n 's/^gateway *= *"\(.*\)"/\1/p' "$HOME/.aidev/runner.toml" | head -1); fi
  gateway=${gateway:-https://dev.nado.work}; gateway=${gateway%/}
  list=$(curl -fsSL "$gateway/_runner/download") || { echo "$gateway 에서 러너 목록을 받지 못했습니다"; exit 1; }
  pick=$(printf '%s' "$list" | tr '{' '\n' | grep -E "\"platform\":\"mac-($arch|universal)\"" | tail -1 || true)
  fname=$(printf '%s' "$pick" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
  sha=$(printf '%s' "$pick" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
  if [ -z "$fname" ]; then
    echo "이 서버에는 macOS 러너 바이너리가 없습니다 — 이 Mac에서 빌드하세요:"
    echo "  curl -fsSL $gateway/_runner/source/aidev-runner-src.tar.gz | tar -xz && ./aidev-runner-src/scripts/build-macos.sh --install${code:+ --code $code} --gateway $gateway"
    exit 1
  fi
  echo "==> 내려받기: $gateway/_runner/download/$fname"
  curl -fsSL "$gateway/_runner/download/$fname" -o "$tmp/aidev-runner"
  got=$(shasum -a 256 "$tmp/aidev-runner" | cut -d' ' -f1)
  [ -z "$sha" ] || [ "$got" = "$sha" ] || { echo "SHA-256이 다릅니다 (받음 $got, 목록 $sha) — 설치하지 않습니다"; exit 1; }
  file="$tmp/aidev-runner"
fi
[ -f "$file" ] || { echo "$file 이 없습니다"; exit 1; }
chmod 755 "$file"; xattr -c "$file" 2>/dev/null || true
ver=$("$file" --version 2>/dev/null | awk '{print $2}') || { echo "$file 을 실행하지 못했습니다"; exit 1; }
old=""; [ -x "$DEST" ] && old=$("$DEST" --version 2>/dev/null | awk '{print $2}' || true)
[ -f "$plist" ] && echo "현재 서비스 실행 파일: $(plutil -extract ProgramArguments.0 raw "$plist" 2>/dev/null || echo '?')"
echo "==> 설치: $file → $DEST (${old:-없음} → $ver)"
stop_running
mkdir -p "$(dirname "$DEST")"
cp "$file" "$DEST.new" && chmod 755 "$DEST.new"
xattr -c "$DEST.new" 2>/dev/null || true
# Signed with this Mac's own runner identity, the same for every version: macOS keeps the Screen Recording and
# Accessibility permissions it was given (they belong to the signature — an ad-hoc signature is a new hash per build,
# so every update asked again). The identity is made once, in a keychain of its own (~/.aidev/signing.keychain-db);
# the login keychain is not touched, and the keychain search list is put back as it was.
sign_stable() {
  local dir="$HOME/.aidev" kc="$HOME/.aidev/signing.keychain-db" pass="$HOME/.aidev/signing.pass" id orig tmp
  mkdir -p "$dir"
  if [ ! -f "$kc" ] || [ ! -s "$pass" ]; then
    command -v openssl >/dev/null || return 1
    rm -f "$kc"; (umask 077; openssl rand -hex 24 > "$pass")
    tmp=$(mktemp -d)
    printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=NadoVibe Runner (%s)\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' "$(hostname -s)" > "$tmp/cfg"
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key" -out "$tmp/cert" -days 7300 -config "$tmp/cfg" >/dev/null 2>&1 &&
      { openssl pkcs12 -export -legacy -inkey "$tmp/key" -in "$tmp/cert" -out "$tmp/id.p12" -passout pass:x >/dev/null 2>&1 ||
        openssl pkcs12 -export -inkey "$tmp/key" -in "$tmp/cert" -out "$tmp/id.p12" -passout pass:x >/dev/null 2>&1; } &&
      security create-keychain -p "$(cat "$pass")" "$kc" >/dev/null 2>&1 &&
      security set-keychain-settings "$kc" >/dev/null 2>&1 &&
      security unlock-keychain -p "$(cat "$pass")" "$kc" >/dev/null 2>&1 &&
      security import "$tmp/id.p12" -k "$kc" -P x -T /usr/bin/codesign >/dev/null 2>&1 &&
      security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(cat "$pass")" "$kc" >/dev/null 2>&1
    local made=$?
    rm -rf "$tmp"
    [ $made = 0 ] || { rm -f "$kc"; return 1; }
    chmod 600 "$kc"
    echo " ✓ 이 Mac의 러너 서명 인증서를 만들었습니다 (업데이트해도 macOS 권한 유지)"
  fi
  security unlock-keychain -p "$(cat "$pass")" "$kc" >/dev/null 2>&1 || return 1
  id=$(security find-identity "$kc" 2>/dev/null | awk '/NadoVibe Runner/ {print $2; exit}')
  [ -n "$id" ] || return 1
  orig=$(security list-keychains -d user | tr -d '"' | xargs)
  security list-keychains -d user -s $orig "$kc"
  codesign --force --sign "$id" --identifier work.nado.aidev-runner "$1" >/dev/null 2>&1; local ok=$?
  security list-keychains -d user -s $orig
  return $ok
}
sign_stable "$DEST.new" || {
  echo " ! 고정 서명을 만들지 못해 ad-hoc 서명을 씁니다 — 업데이트하면 macOS가 화면 기록 권한을 다시 물을 수 있습니다"
  codesign --force --sign - --identifier work.nado.aidev-runner "$DEST.new" >/dev/null 2>&1 || true
}
mv -f "$DEST.new" "$DEST"
echo "==> $("$DEST" --version)"

# ---- pairing -------------------------------------------------------------------------------------------
if [ -n "$code" ]; then
  args=(pair "$code"); [ -n "$gateway" ] && args+=(--gateway "$gateway"); [ -n "$name" ] && args+=(--name "$name")
  "$DEST" "${args[@]}"
fi
if ! "$DEST" status >/dev/null 2>&1; then
  cat <<EOF

설치했습니다. 이 PC는 아직 페어링되지 않았습니다 — 작업대 "원격 대상"에서 대상을 만들고 코드를 받아:
    $([ -f "$0" ] && echo "$0" || echo "curl -fsSL ${gateway:-https://dev.nado.work}/_runner/scripts/install-macos.sh | bash -s --") --code <페어링 코드> --gateway ${gateway:-https://dev.nado.work}
EOF
  exit 0
fi
[ $service = 1 ] || { echo "설치만 했습니다 (--no-service). 실행: $DEST   (서비스 설치: $DEST install)"; exit 0; }

# ---- the runner's own `install`: LaunchAgent, LaunchDaemon (from boot) and passwordless sudo unless restricted ----
logf="$HOME/.aidev/runner.log"; since=$( [ -f "$logf" ] && wc -c < "$logf" | tr -d ' ' || echo 0)   # only lines written after this
"$DEST" install ${svc_flags[@]+"${svc_flags[@]}"}

# ---- verify: the service runs $DEST, no other runner is left, and it connected -----------------------------
ok=1; pid=""; running=""
# launchd starts the job through xpcproxy, which then execs the runner under the same pid: until that exec
# the process shows as "xpcproxy work.nado.aidev-runner" — wait for the runner itself, not the launcher
for i in $(seq 1 20); do
  pid=$(launchctl print "$label" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}')
  running=$([ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null || true)
  [ -n "$pid" ] && [ "${running%% *}" = "$DEST" ] && break
  sleep 1
done
if [ -n "$pid" ] && [ "${running%% *}" = "$DEST" ]; then echo " ✓ 서비스 실행 중: pid $pid ($DEST)"; else echo " ✗ 서비스가 $DEST 로 실행되지 않았습니다 (${running:-실행 안 됨})"; ok=0; fi
# (the LaunchDaemon's boot runner, `start --boot`, is meant to run beside it: it hands over to the session's runner)
others=$(ps -axo pid=,command= | grep -i 'aidev-runner' | grep -v grep | grep -v -- '--boot' | grep -v "^ *$pid " | grep -v "$0" || true)
if [ -n "$others" ]; then
  echo " ✗ 다른 러너가 아직 실행 중입니다 (같은 토큰이면 연결을 서로 빼앗습니다) — 종료합니다:"; echo "$others" | sed 's/^/     /'
  echo "$others" | awk '{print $1}' | xargs kill 2>/dev/null || true
fi
connected=""
for i in $(seq 1 20); do
  connected=$(tail -c +$((since + 1)) "$logf" 2>/dev/null | grep '연결됨' | tail -1 || true)   # no match yet: keep waiting (set -e)
  [ -n "$connected" ] && break; sleep 1
done
if [ -n "$connected" ]; then echo " ✓ $connected"; else echo " ✗ 20초 안에 게이트웨이에 연결되지 않았습니다 — 로그: tail -30 ~/.aidev/runner.log"; ok=0; fi
[ "$ok" = 1 ] && echo " ✓ 러너 $ver 로 교체 완료" || echo " ✗ 교체를 확인하지 못했습니다 — 위 메시지와 로그를 확인하세요"
"$DEST" status 2>/dev/null | grep -E 'screen|remote control' || true
cat <<EOF

완료. 작업대 "원격 대상"에서 러너 버전이 $ver 로 바뀌었는지 확인하세요.
- 화면 보기·원격 제어는 첫 실행에서 허용됩니다 (끄기: $DEST consent screen off).
- macOS가 처음 한 번 "화면 기록"·"손쉬운 사용" 허용을 물으면 켜 주세요. 이 Mac의 고정 서명으로 설치하므로
  업데이트해도 다시 묻지 않습니다.
- 로그: ~/.aidev/runner.log
EOF
[ "$ok" = 1 ]
