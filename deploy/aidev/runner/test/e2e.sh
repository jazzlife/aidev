#!/usr/bin/env bash
# F-01 e2e against mock-hub.mjs: pair → token file 0600 → start → hello/ping/fs.resolve → reconnect → 4401 stops (exit 3)
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=${BIN:-target/debug/aidev-runner}
export AIDEV_RUNNER_HOME=$(mktemp -d) HOME=$(mktemp -d)
WS_MODULE=${WS_MODULE:-$(cd ../auth-gateway && pwd)/node_modules/ws} PORT=18181 node test/mock-hub.mjs > "$AIDEV_RUNNER_HOME/mock.log" 2>&1 &
MOCK=$!; trap 'kill $MOCK 2>/dev/null; rm -rf "$AIDEV_RUNNER_HOME" "$HOME"' EXIT
for i in $(seq 1 50); do grep -q listening "$AIDEV_RUNNER_HOME/mock.log" 2>/dev/null && break; sleep 0.1; done
fail=0; ok() { echo "PASS $1"; }; no() { echo "FAIL $1"; fail=1; }
$BIN pair WRONG123 --gateway http://127.0.0.1:18181 >/dev/null 2>&1 && no "bad code refused" || ok "bad code refused"
$BIN pair abcd1234 --gateway http://example.com >/dev/null 2>&1 && no "plain http to a remote host refused" || ok "plain http to a remote host refused"
$BIN pair abcd1234 --gateway http://127.0.0.1:18181 | grep -q "대상 #7 test-pc" && ok "paired" || no "paired"
perm=$(stat -c %a "$AIDEV_RUNNER_HOME/runner.toml"); [ "$perm" = 600 ] && ok "runner.toml mode 600" || no "runner.toml mode $perm"
$BIN status | grep -q aaaaaaaa && no "status hides the token" || ok "status hides the token"
[ -d "$HOME/aidev-work" ] && ok "default root ~/aidev-work created" || no "default root"
set +e; timeout 30 $BIN start > "$AIDEV_RUNNER_HOME/runner.log" 2>&1; code=$?; set -e
[ $code -eq 3 ] && ok "revoked token (4401) stops the runner with exit 3" || no "exit code $code"
grep -q "ping result {\"pong\":true" "$AIDEV_RUNNER_HOME/mock.log" && ok "runner.ping answered" || no "runner.ping"
grep -q 'fs.resolve {"code":-32001' "$AIDEV_RUNNER_HOME/mock.log" && ok "path outside allowed_roots refused" || no "fs.resolve"
[ "$(grep -c '^\[mock\] connected' "$AIDEV_RUNNER_HOME/mock.log")" -ge 2 ] && ok "reconnected after close" || no "reconnect"
grep -q '"os":"linux"' "$AIDEV_RUNNER_HOME/mock.log" && grep -q '"roots":1' "$AIDEV_RUNNER_HOME/mock.log" && ok "capabilities reported" || no "capabilities"
sed -i 's/^token = .*/token = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/' "$AIDEV_RUNNER_HOME/runner.toml"
set +e; timeout 20 $BIN start >/dev/null 2>&1; code=$?; set -e
[ $code -eq 3 ] && ok "wrong token rejected at the handshake (401) stops with exit 3" || no "handshake 401 exit $code"
echo "--- mock"; cat "$AIDEV_RUNNER_HOME/mock.log"; echo "--- runner"; cat "$AIDEV_RUNNER_HOME/runner.log"
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
