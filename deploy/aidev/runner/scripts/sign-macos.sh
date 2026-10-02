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
if [ ! -f "$kc" ] || [ ! -s "$pass" ]; then
  command -v openssl >/dev/null || exit 1
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
  made=$?
  rm -rf "$tmp"
  [ $made = 0 ] || { rm -f "$kc"; exit 1; }
  chmod 600 "$kc"
fi
security unlock-keychain -p "$(cat "$pass")" "$kc" >/dev/null 2>&1 || exit 1
id=$(security find-identity "$kc" 2>/dev/null | awk '/NadoVibe Runner/ {print $2; exit}')
[ -n "$id" ] || exit 1
orig=$(security list-keychains -d user | tr -d '"' | xargs)
security list-keychains -d user -s $orig "$kc"
codesign --force --sign "$id" --identifier work.nado.aidev-runner "$bin" >/dev/null 2>&1; ok=$?
security list-keychains -d user -s $orig
exit $ok
