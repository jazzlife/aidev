#!/bin/bash
# macOS: sign a runner binary with this Mac's own runner identity — the same for every version, so the Screen Recording
# and Accessibility permissions given once stay valid across updates (an ad-hoc signature is a new hash per build, and
# macOS then treats each update as a new app). The identity is made once, in a keychain of its own
# (~/.aidev/signing.keychain-db); the login keychain is not touched and the keychain search list is put back as it was.
# Used by `aidev-runner install` (embedded) and kept in step with install-macos.sh's sign_stable.
#   sign-macos.sh <binary>      exit 0 when signed with the stable identity
set -uo pipefail
bin=${1:?binary}
dir="$HOME/.aidev"; kc="$dir/signing.keychain-db"; pass="$dir/signing.pass"
mkdir -p "$dir"
# what each step said, for when it fails (the runner points to this file)
log="$dir/signing.log"; : > "$log"
fail() { echo "고정 서명 실패: $1 — $(tail -2 "$log" | tr '\n' ' ')" >&2; exit 1; }
if [ ! -f "$kc" ] || [ ! -s "$pass" ]; then
  command -v openssl >/dev/null || fail "openssl이 없습니다"
  rm -f "$kc"; (umask 077; openssl rand -hex 24 > "$pass")
  tmp=$(mktemp -d)
  printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=NadoVibe Runner (%s)\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' "$(hostname -s | cut -c1-40)" > "$tmp/cfg"   # CN ≤ 64 characters (a long host name failed: "string too long")
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key" -out "$tmp/cert" -days 7300 -config "$tmp/cfg" >>"$log" 2>&1 &&
    { openssl pkcs12 -export -legacy -inkey "$tmp/key" -in "$tmp/cert" -out "$tmp/id.p12" -passout pass:x >>"$log" 2>&1 ||
      openssl pkcs12 -export -inkey "$tmp/key" -in "$tmp/cert" -out "$tmp/id.p12" -passout pass:x >>"$log" 2>&1; } &&
    security create-keychain -p "$(cat "$pass")" "$kc" >>"$log" 2>&1 &&
    security set-keychain-settings "$kc" >>"$log" 2>&1 &&
    security unlock-keychain -p "$(cat "$pass")" "$kc" >>"$log" 2>&1 &&
    security import "$tmp/id.p12" -k "$kc" -P x -T /usr/bin/codesign >>"$log" 2>&1 &&
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(cat "$pass")" "$kc" >>"$log" 2>&1
  made=$?
  rm -rf "$tmp"
  [ $made = 0 ] || { rm -f "$kc"; fail "서명용 인증서·키체인을 만들지 못했습니다"; }
  chmod 600 "$kc"
fi
security unlock-keychain -p "$(cat "$pass")" "$kc" >>"$log" 2>&1 || fail "서명용 키체인을 열지 못했습니다"
id=$(security find-identity "$kc" 2>/dev/null | awk '/NadoVibe Runner/ {print $2; exit}')
[ -n "$id" ] || fail "키체인에 서명 인증서가 없습니다"
orig=$(security list-keychains -d user | tr -d '"' | xargs)
security list-keychains -d user -s $orig "$kc"
codesign --force --sign "$id" --identifier work.nado.aidev-runner "$bin" >>"$log" 2>&1; ok=$?
security list-keychains -d user -s $orig
[ $ok = 0 ] || fail "codesign"
exit 0
