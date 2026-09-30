#!/usr/bin/env bash
# The workbench pairing card's commands, pasted into real shells (F-02):
#   bash test/pairing-commands.sh <gateway> <token> <workdir>
# Generates the lines with the card's own code (src/modules/remote-target/utils/runnerPairing.ts) for each OS
# and runs them: Linux → bash, macOS → zsh (its default shell; `#` is not a comment there), Windows →
# PowerShell (parsed, then run with curl.exe / the runner stubbed). The service manager is stubbed
# (systemctl logs its arguments). Prints one JSON line per shell.
set -uo pipefail
G=$1; A=$2; W=$3
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
mkdir -p "$W"
"$repo/node_modules/.bin/esbuild" "$repo/src/modules/remote-target/utils/runnerPairing.ts" --bundle --format=esm --platform=node \
  "--alias:@=$repo/src" --outfile="$W/pairing.mjs" --log-level=error
files=$(curl -s "$G/_runner/download")
newcode() { curl -s -X POST "$G/api/aidev/targets" -H "authorization: Bearer $A" -H 'content-type: application/json' -d "{\"name\":\"paste-$1\",\"policy\":\"ask\"}" | node -pe 'const t=JSON.parse(require("fs").readFileSync(0)).target; t.id+" "+t.pairing_code'; }
gen() {   # platform code [fileJson] → the commands
  node --input-type=module -e "
    const m = await import('$W/pairing.mjs');
    const files = JSON.parse(process.argv[1]).files; const fake = process.argv[4] ? JSON.parse(process.argv[4]) : null;
    const file = fake ?? files.find((f) => f.platform === process.argv[2]);
    process.stdout.write(m.pairingSteps({ platform: process.argv[2], file, code: process.argv[3], gateway: '$G' }).commands);" "$files" "$@"
}
stubs() {   # a PATH dir whose systemctl records its arguments
  mkdir -p "$1/stub"; printf '#!/bin/sh\necho "$@" >> "%s/systemctl.log"\n' "$1" > "$1/stub/systemctl"; chmod +x "$1/stub/systemctl"
}
paired() {  # home targetId shell → JSON result
  local H=$1 tid=$2 sh=$3
  local online=false
  local unit="$H/.config/systemd/user/aidev-runner.service"
  node -e "
    const fs=require('fs'); const H=process.argv[1];
    const out={shell:process.argv[3], exe: fs.existsSync(H+'/.aidev/bin/aidev-runner') && (fs.statSync(H+'/.aidev/bin/aidev-runner').mode & 0o111)!==0,
      paired: fs.existsSync(H+'/.aidev/runner.toml'),
      unitExec: (fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2],'utf8').match(/ExecStart=(.*)/)?.[1] : null),
      serviceStarted: fs.existsSync(H+'/systemctl.log') && /enable --now aidev-runner.service/.test(fs.readFileSync(H+'/systemctl.log','utf8')),
      exitCode: Number(process.argv[4])};
    out.unitPointsAtFixedPath = out.unitExec === JSON.stringify(H+'/.aidev/bin/aidev-runner')+' start';
    console.log(JSON.stringify(out));" "$H" "$unit" "$sh" "$4"
}

# Linux (bash): download from the gateway, pair, register the service
read -r TID CODE <<<"$(newcode linux)"; H="$W/home-bash"; mkdir -p "$H"; stubs "$H"
gen linux-x64 "$CODE" > "$W/linux.txt"
( cd "$H" && env -i HOME="$H" PATH="$H/stub:/usr/bin:/bin" bash -e "$W/linux.txt" > "$W/bash.log" 2>&1 ); rc=$?
paired "$H" "$TID" bash $rc

# macOS (zsh): no mac binary on the server → the card says to build/install first; then its two lines run as pasted
read -r TID CODE <<<"$(newcode mac)"; H="$W/home-zsh"; mkdir -p "$H/.aidev/bin"; stubs "$H"
linux=$(node -pe 'JSON.parse(process.argv[1]).files.find(f=>f.platform==="linux-x64").name' "$files")
curl -s "$G/_runner/download/$linux" -o "$H/.aidev/bin/aidev-runner"; chmod +x "$H/.aidev/bin/aidev-runner"   # what install.sh leaves
gen mac-universal "$CODE" > "$W/mac.txt"
# interactive zsh semantics (no interactivecomments): paste line by line
( cd "$H" && env -i HOME="$H" PATH="$H/stub:/usr/bin:/bin" zsh -f -i -o nointeractivecomments < "$W/mac.txt" > "$W/zsh.log" 2>&1 ); rc=$?
paired "$H" "$TID" zsh $rc
# the same lines with the old card's trailing comment would have failed in zsh — keep proving the reason
printf 'echo pasted  # 또는 start\n' > "$W/comment.txt"; zsh -f -i -o nointeractivecomments < "$W/comment.txt" > "$W/zsh-comment.log" 2>&1
node -e "console.log(JSON.stringify({shell:'zsh-comment-check', commentIsWord: require('fs').readFileSync(process.argv[1],'utf8').includes('#')}))" "$W/zsh-comment.log"

# Windows (PowerShell): parse, then run with curl.exe and the runner stubbed, recording the arguments
PWSH=${PWSH:-$(command -v pwsh || true)}
if [ -n "$PWSH" ]; then
  gen win-x64 CODE1234 '{"name":"aidev-runner-0.7.0-win-x64.exe","platform":"win-x64","version":"0.7.0","size":1,"sha256":null}' > "$W/win.ps1"
  H="$W/home-pwsh"; mkdir -p "$H/stub"
  printf '#!/bin/sh\nprintf "curl %%s\\n" "$*" >> "%s/calls.log"\n' "$H" > "$H/stub/curl.exe"; chmod +x "$H/stub/curl.exe"
  HOME="$H" PATH="$H/stub:$PATH" "$PWSH" -NoProfile -NonInteractive -Command "
    \$errs = \$null; [void][System.Management.Automation.Language.Parser]::ParseInput((Get-Content -Raw '$W/win.ps1'), [ref]\$null, [ref]\$errs)
    # the runner: a stub at the path the card installs to (on Windows that is %USERPROFILE%\\.aidev\\bin)
    \$exe = \"\$HOME\\.aidev\\bin\\aidev-runner.exe\"
    function global:stubRun { }
    \$ErrorActionPreference = 'Stop'
    \$lines = Get-Content '$W/win.ps1'
    # New-Item runs for real; curl.exe is the stub; '& <exe> …' is recorded instead of run (no Windows binary here)
    \$calls = @()
    foreach (\$l in \$lines) {
      if (\$l.StartsWith('& ')) { \$ast = [System.Management.Automation.Language.Parser]::ParseInput(\$l, [ref]\$null, [ref]\$null); \$cmd = \$ast.EndBlock.Statements[0].PipelineElements[0]; \$calls += ,(@(\$cmd.CommandElements | ForEach-Object { if (\$_ -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) { \$ExecutionContext.InvokeCommand.ExpandString(\$_.Value) } else { \$_.SafeGetValue() } }) -join ' ') }
      else { Invoke-Expression \$l }
    }
    \$o = [ordered]@{ shell='powershell'; parseErrors=\$errs.Count; binDir=(Test-Path -PathType Container (Join-Path \$HOME '.aidev/bin')); curl=((Get-Content '$H/calls.log' -ErrorAction SilentlyContinue) -join ''); runner=\$calls; home=\$HOME }
    \$o | ConvertTo-Json -Compress" 2> "$W/pwsh.err" || echo "{\"shell\":\"powershell\",\"error\":$(node -pe 'JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8").slice(0,300))' "$W/pwsh.err")}"
else
  echo '{"shell":"powershell","skipped":true}'
fi
