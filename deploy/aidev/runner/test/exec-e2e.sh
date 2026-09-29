#!/usr/bin/env bash
# A Mac-like zsh user: ~/.zshrc asks a question on stdin (oh-my-zsh update prompt) and adds a PATH entry.
# The command must not hang, must see the PATH from .zshrc, and "~/aidev-work" must resolve to the home folder.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=${BIN:-target/debug/aidev-runner}
H=$(mktemp -d); trap 'rm -rf "$H"' EXIT
mkdir -p "$H/aidev-work" "$H/.aidev" "$H/bin"; printf '#!/bin/sh\necho mytool-1.0\n' > "$H/bin/mytool"; chmod +x "$H/bin/mytool"
cat > "$H/.zshrc" <<'RC'
export PATH="$HOME/bin:$PATH"
read -q "REPLY?[oh-my-zsh] Would you like to update? [Y/n] "
RC
printf 'gateway = "http://127.0.0.1:18182"\ntoken = "%s"\ntarget_id = 1\nname = "t"\nallowed_roots = ["%s"]\n' "$(printf 'a%.0s' $(seq 1 64))" "$H/aidev-work" > "$H/.aidev/runner.toml"
WS_MODULE=${WS_MODULE:-$(cd ../auth-gateway && pwd)/node_modules/ws} EXEC_CWD="$( [ "${EXEC_CWD:-}" = ABS ] && echo "$H/aidev-work" || echo "${EXEC_CWD:-~/aidev-work}")" EXEC_CMD='echo hi-$((1+1)); pwd; mytool' node test/exec-hub.mjs > "$H/hub.log" 2>&1 & HUB=$!
for i in $(seq 1 50); do grep -q listening "$H/hub.log" && break; sleep 0.1; done
HOME="$H" SHELL=$(command -v zsh) AIDEV_RUNNER_HOME="$H/.aidev" timeout 40 "$BIN" start > "$H/runner.log" 2>&1 || true
wait $HUB || true
cat "$H/hub.log" | grep -v listening
grep -q "EXIT code=0" "$H/hub.log" && grep -q "hi-2" "$H/hub.log" && grep -q "mytool-1.0" "$H/hub.log" && grep -q "aidev-work" "$H/hub.log" && echo "PASS zsh user: no hang, ~ resolved, PATH from .zshrc" || { echo FAIL; cat "$H/runner.log"; exit 1; }
