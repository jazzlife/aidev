<#
.SYNOPSIS
  Windows: install aidev-runner at %USERPROFILE%\.aidev\bin\aidev-runner.exe, pair it and keep it running
  (a logon task "aidev-runner" that starts it without a console window, output in %USERPROFILE%\.aidev\runner.log).

.DESCRIPTION
  Without -File/-Dist the binary comes from the gateway (/_runner/download) and its SHA-256 is checked.
  Also served by the gateway, so a new PC needs one line in PowerShell:
    & ([scriptblock]::Create((irm https://dev.nado.work/_runner/scripts/install-windows.ps1))) -Code <코드>

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Code ABCD-1234
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -File dist\aidev-runner-0.9.0-win-x64.exe
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Uninstall
  # from an administrator PowerShell — what WinRM gives: commands run elevated (services, registry, firewall),
  # and/or the runner starts at boot without a sign-in (build/test machines; no screen capture then)
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Code ABCD-1234 -Elevated -AtStartup
#>
[CmdletBinding()]
param(
  [string] $File,
  [string] $Dist,
  [string] $Code,
  [string] $Gateway,
  [string] $Name,
  [switch] $NoService,
  [switch] $Elevated,
  [switch] $AtStartup,
  [switch] $Uninstall
)
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 turns a native program's stderr into error records when output is redirected (CI, a
# pipe) — with ErrorActionPreference Stop the first "Compiling …" line would end the script. Native programs
# run through this: stderr is shown as text and only the exit code decides.
function Invoke-Native([string] $Exe, [string[]] $ArgList = @(), [switch] $Quiet) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & $Exe @ArgList 2>&1 | ForEach-Object {
      if ($Quiet) { return }
      if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() } else { Write-Host $_ }
    }
  } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}
# AIDEV_INSTALL_TEST=1: the platform's own test of this script on another OS (only its own binary is stopped)
$TestMode = [bool]$env:AIDEV_INSTALL_TEST
if ($env:OS -ne 'Windows_NT' -and -not $TestMode) { throw 'Windows 전용입니다 (Linux: install-linux.sh, macOS: install-macos.sh)' }
$Home_ = $env:USERPROFILE
$Dest = Join-Path $Home_ '.aidev\bin\aidev-runner.exe'
$Log = Join-Path $Home_ '.aidev\runner.log'
$Toml = Join-Path $Home_ '.aidev\runner.toml'
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }

function Stop-Runner {
  if (-not $TestMode) { try { schtasks /End /TN aidev-runner 2>$null | Out-Null } catch { } }
  # every runner of this user (a terminal `start`, the task): only one may be connected with this PC's token
  # (other users' runners cannot be stopped without admin rights and are left alone)
  Get-Process aidev-runner -ErrorAction SilentlyContinue | Where-Object { -not $TestMode -or $_.Path -eq $Dest } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

if ($Uninstall) {
  Stop-Runner
  if (Test-Path $Dest) { [void](Invoke-Native $Dest @('uninstall-service') -Quiet) }
  Write-Host "로그온 작업을 멈추고 지웠습니다 (페어링은 $Toml 에 남아 있습니다 — 지우려면 `"$Dest`" unpair)"
  exit 0
}

# ---- the binary -----------------------------------------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("aidev-runner-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  if (-not $File -and $Dist) {
    $File = Get-ChildItem $Dist -Filter "aidev-runner-*-win-$Arch.exe" -ErrorAction SilentlyContinue |
      Sort-Object { [version](($_.Name -replace '^aidev-runner-', '' -replace "-win-$Arch\.exe$", '')) } | Select-Object -Last 1 -ExpandProperty FullName
    if (-not $File) { throw "$Dist 에 win-$Arch 러너가 없습니다 — scripts\build-windows.ps1 로 빌드하세요" }
  }
  if (-not $File) {
    if (-not $Gateway -and (Test-Path $Toml)) {
      $m = Select-String -Path $Toml -Pattern '^gateway *= *"(.*)"' | Select-Object -First 1
      if ($m) { $Gateway = $m.Matches[0].Groups[1].Value }
    }
    if (-not $Gateway) { $Gateway = 'https://dev.nado.work' }
    $Gateway = $Gateway.TrimEnd('/')
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $list = Invoke-RestMethod "$Gateway/_runner/download"
    $pick = $list.files | Where-Object { $_.platform -eq "win-$Arch" } | Select-Object -Last 1
    if (-not $pick) {
      Write-Host "이 서버에는 win-$Arch 러너 바이너리가 없습니다 — 이 PC에서 빌드하세요:"
      Write-Host "  curl.exe -fsSL $Gateway/_runner/source/aidev-runner-src.tar.gz -o aidev-runner-src.tar.gz; tar -xzf aidev-runner-src.tar.gz"
      Write-Host "  powershell -ExecutionPolicy Bypass -File aidev-runner-src\scripts\build-windows.ps1 -InstallTools -Install$(if ($Code) { " -Code $Code" }) -Gateway $Gateway"
      exit 1
    }
    Write-Host "==> 내려받기: $Gateway/_runner/download/$($pick.name)"
    $File = Join-Path $tmp 'aidev-runner.exe'
    Invoke-WebRequest -UseBasicParsing "$Gateway/_runner/download/$($pick.name)" -OutFile $File
    $got = (Get-FileHash -Algorithm SHA256 $File).Hash.ToLower()
    if ($pick.sha256 -and $got -ne $pick.sha256) { throw "SHA-256이 다릅니다 (받음 $got, 목록 $($pick.sha256)) — 설치하지 않습니다" }
  }
  if (-not (Test-Path $File)) { throw "$File 이 없습니다" }
  if (-not $TestMode) { Unblock-File $File -ErrorAction SilentlyContinue }   # the "downloaded from the internet" mark
  $newVer = ((& $File --version) -split ' ')[1]
  $oldVer = if (Test-Path $Dest) { try { ((& $Dest --version) -split ' ')[1] } catch { '?' } } else { '없음' }
  Write-Host "==> 설치: $Dest ($oldVer → $newVer)"
  Stop-Runner
  New-Item -ItemType Directory -Force (Split-Path -Parent $Dest) | Out-Null
  Copy-Item -Force $File "$Dest.new"
  Move-Item -Force "$Dest.new" $Dest
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ---- pairing --------------------------------------------------------------------------------------------
if ($Code) {
  $p = @('pair', $Code)
  if ($Gateway) { $p += @('--gateway', $Gateway) }
  if ($Name) { $p += @('--name', $Name) }
  $code = Invoke-Native $Dest $p
  if ($code -ne 0) { throw "페어링 실패 ($code) — 코드가 만료됐으면 작업대에서 새 코드를 받으세요" }
}
if ((Invoke-Native $Dest @('status') -Quiet) -ne 0) {
  Write-Host ''
  Write-Host '설치했습니다. 이 PC는 아직 페어링되지 않았습니다 — 작업대 "원격 대상"에서 코드를 받아:'
  $gw = if ($Gateway) { $Gateway } else { 'https://dev.nado.work' }
  if ($PSCommandPath) { Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Code <페어링 코드>" }
  else { Write-Host "  & ([scriptblock]::Create((irm $gw/_runner/scripts/install-windows.ps1))) -Code <페어링 코드>" }
  exit 0
}
if ($NoService) { Write-Host "설치만 했습니다 (-NoService). 실행: & `"$Dest`"   (또는 탐색기에서 더블클릭; 서비스 설치: & `"$Dest`" install)"; exit 0 }

# ---- keep it running: logon task, started now ----------------------------------------------------------------
$since = if (Test-Path $Log) { (Get-Item $Log).Length } else { 0 }
$svcArgs = @('install-service')
if ($Elevated) { $svcArgs += '--elevated' }
if ($AtStartup) { $svcArgs += '--at-startup' }
if (($Elevated -or $AtStartup) -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '-Elevated / -AtStartup은 관리자 권한 PowerShell에서 실행하세요'
}
if ((Invoke-Native $Dest $svcArgs) -ne 0) { throw 'install-service 실패' }

# ---- verify ---------------------------------------------------------------------------------------------
$ok = $false; $line = $null
for ($i = 0; $i -lt 20; $i++) {
  $proc = Get-Process aidev-runner -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Dest }
  if ($proc -and (Test-Path $Log)) {
    $fs = [IO.File]::Open($Log, 'Open', 'Read', 'ReadWrite')
    try {
      [void]$fs.Seek([Math]::Min($since, $fs.Length), 'Begin')
      $text = (New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)).ReadToEnd()
    } finally { $fs.Close() }
    $line = ($text -split "`n" | Where-Object { $_ -match '연결됨' } | Select-Object -Last 1)
    if ($line) { $ok = $true; break }
  }
  Start-Sleep -Seconds 1
}
if ($ok) { Write-Host " ✓ 실행 중이고 플랫폼에 연결됨: $($line.Trim())" }
elseif (Get-Process aidev-runner -ErrorAction SilentlyContinue) { Write-Host " ! 실행 중이지만 20초 안에 연결 기록을 못 봤습니다 — 로그: $Log" }
else { Write-Host " ✗ 러너가 실행되지 않았습니다 — 로그: $Log / 작업 스케줄러의 aidev-runner"; exit 1 }
Write-Host ''
Write-Host '완료. 작업대 "원격 대상"에서 이 PC가 온라인인지 확인하세요.'
Write-Host "- 화면 보기·원격 제어는 한 번 허용해야 합니다: & `"$Dest`" consent screen on  (또는 consent control on), 그다음 schtasks /Run /TN aidev-runner"
Write-Host "- 로그: $Log"
