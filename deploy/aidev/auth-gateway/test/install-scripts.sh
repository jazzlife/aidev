#!/usr/bin/env bash
# The per-OS install scripts served by the gateway (/_runner/scripts/…), run for real against it:
#   bash test/install-scripts.sh <gateway> <user token> <workdir>
# Linux: `curl …/install-linux.sh | bash -s -- --code …` in a clean HOME → downloads the linux-x64 runner from
# the gateway (SHA-256 checked), pairs, keeps it running (systemd user service, or here — no systemd — a
# background process + cron), sees it connect; the target is then online; --uninstall stops it.
# Windows script (PowerShell, when pwsh is installed): fetched with irm and run as a scriptblock in test mode
# (AIDEV_INSTALL_TEST: any OS, only its own binary is stopped) with a local binary: installs, pairs.
# Both run without the caller's AIDEV_RUNNER_HOME (the smoke runner's configuration must stay untouched).
# Prints one JSON line per case.
set -uo pipefail
G=$1; A=$2; W=$3
mkdir -p "$W"
newcode() { curl -s -X POST "$G/api/aidev/targets" -H "authorization: Bearer $A" -H 'content-type: application/json' -d "{\"name\":\"install-$1\",\"policy\":\"ask\"}" | node -pe 'const t=JSON.parse(require("fs").readFileSync(0)).target; t.id+" "+t.pairing_code'; }
online() { curl -s "$G/api/aidev/targets" -H "authorization: Bearer $A" | node -pe "Boolean((JSON.parse(require('fs').readFileSync(0)).targets.find(t=>t.id===$1)||{}).online)"; }

# ---- Linux ----
read -r TID CODE <<<"$(newcode linux)"; H="$W/home-linux"; mkdir -p "$H"
( cd "$H" && curl -fsSL "$G/_runner/scripts/install-linux.sh" | env -i HOME="$H" PATH=/usr/local/bin:/usr/bin:/bin bash -s -- --code "$CODE" --gateway "$G" > "$W/linux.log" 2>&1 ); rc=$?
on=false; for _ in $(seq 1 20); do [ "$(online "$TID")" = true ] && { on=true; break; }; sleep 0.5; done
( env -i HOME="$H" PATH=/usr/bin:/bin bash -c "curl -fsSL '$G/_runner/scripts/install-linux.sh' | bash -s -- --uninstall" > "$W/linux-un.log" 2>&1 )
off=false; for _ in $(seq 1 30); do [ "$(online "$TID")" = false ] && { off=true; break; }; sleep 0.5; done
node -e "const fs=require('fs'); const log=fs.readFileSync(process.argv[1],'utf8'); console.log(JSON.stringify({case:'linux', exit:Number(process.argv[2]),
  downloaded: /내려받기: .*linux-x64/.test(log), exe: fs.existsSync(process.argv[3]+'/.aidev/bin/aidev-runner'), paired: fs.existsSync(process.argv[3]+'/.aidev/runner.toml'),
  connected: /연결됨/.test(log), online: process.argv[4]==='true', stoppedAfterUninstall: process.argv[5]==='true', tail: log.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0,300)}))" "$W/linux.log" $rc "$H" $on $off

# ---- Windows (PowerShell script, test mode) ----
PWSH=${PWSH:-$(command -v pwsh || true)}
if [ -n "$PWSH" ]; then
  read -r TID2 CODE2 <<<"$(newcode windows)"; H2="$W/home-pwsh"; mkdir -p "$H2"
  bin=$(ls "$RUNNER_DIST_DIR"/aidev-runner-*-linux-x64 | sort -V | tail -1)
  env -u AIDEV_RUNNER_HOME HOME="$H2" USERPROFILE="$H2" AIDEV_INSTALL_TEST=1 "$PWSH" -NoProfile -NonInteractive -Command "
    \$ErrorActionPreference = 'Stop'
    & ([scriptblock]::Create((Invoke-RestMethod '$G/_runner/scripts/install-windows.ps1'))) -File '$bin' -Code '$CODE2' -Gateway '$G' -NoService" > "$W/pwsh.log" 2>&1; rc2=$?
  node -e "const fs=require('fs'); const log=fs.readFileSync(process.argv[1],'utf8'); const H=process.argv[3]; console.log(JSON.stringify({case:'windows-ps1', exit:Number(process.argv[2]),
    exe: fs.existsSync(H+'/.aidev/bin/aidev-runner.exe'), paired: fs.existsSync(H+'/.aidev/runner.toml') && /target_id = $TID2/.test(fs.readFileSync(H+'/.aidev/runner.toml','utf8')),
    tail: log.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0,300)}))" "$W/pwsh.log" $rc2 "$H2"
else
  echo '{"case":"windows-ps1","skipped":true}'
fi
