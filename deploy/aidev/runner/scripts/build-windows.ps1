<#
.SYNOPSIS
  Windows: build aidev-runner natively on this PC into ..\dist\aidev-runner-<version>-win-<arch>.exe (+ SHA256SUMS).

.DESCRIPTION
  Needs Rust (https://rustup.rs — the MSVC toolchain), Visual Studio Build Tools with "Desktop development with
  C++" (the built-in H.264 encoder, OpenH264, is compiled from C++ source) and on x64 NASM (its SIMD code).
  -Check only reports what is missing (with the winget command to install it); -InstallTools installs them
  with winget. -Install hands the result to install-windows.ps1 (pairing with -Code, keep-running logon task).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Install -Code ABCD-1234
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Check
#>
[CmdletBinding()]
param(
  [ValidateSet('auto', 'x64', 'arm64')] [string] $Arch = 'auto',
  [switch] $Check,
  [switch] $InstallTools,
  [switch] $Install,
  [string] $Code,
  [string] $Gateway,
  [string] $Name
)
$ErrorActionPreference = 'Stop'
$Src = Split-Path -Parent $PSScriptRoot
if ($env:OS -ne 'Windows_NT') { throw 'Windows 전용입니다 (Linux: scripts/build-linux.sh, macOS: scripts/build-macos.sh)' }
if ($Arch -eq 'auto') {
  $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
}
$Target = if ($Arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }

# ---- toolchain ------------------------------------------------------------------------------------------
function Find-Nasm {
  $c = Get-Command nasm -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($d in @("$env:ProgramFiles\NASM", "${env:ProgramFiles(x86)}\NASM", "$env:LOCALAPPDATA\bin\NASM")) {
    if (Test-Path "$d\nasm.exe") { return "$d\nasm.exe" }
  }
  return $null
}
function Find-Msvc {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { return $null }
  $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if ($path) { return $path } else { return $null }
}
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) { $env:Path = "$cargoBin;$env:Path" }

$missing = @()
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $missing += @{ what = 'Rust (rustup)'; winget = 'Rustlang.Rustup' } }
if (-not (Find-Msvc)) { $missing += @{ what = 'Visual Studio Build Tools (C++)'; winget = 'Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' } }
if ($Arch -eq 'x64' -and -not (Find-Nasm)) { $missing += @{ what = 'NASM (x64 H.264 SIMD)'; winget = 'NASM.NASM' } }

if ($missing.Count -gt 0 -and $InstallTools) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget이 없습니다 — 아래 도구를 직접 설치하세요' }
  foreach ($m in $missing) {
    Write-Host "==> 설치: $($m.what)"
    $wargs = @('install', '--accept-source-agreements', '--accept-package-agreements', '-e', '--id') + ($m.winget -split ' ', 2)[0]
    if ($m.winget -match ' --override (.*)$') { $wargs += @('--override', $Matches[1].Trim('"')) }
    & winget @wargs
  }
  if (Test-Path $cargoBin) { $env:Path = "$cargoBin;$env:Path" }
  $missing = @()
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { $missing += @{ what = 'Rust (새 터미널에서 다시 실행)'; winget = 'Rustlang.Rustup' } }
  if (-not (Find-Msvc)) { $missing += @{ what = 'Visual Studio Build Tools (C++)'; winget = 'Microsoft.VisualStudio.2022.BuildTools' } }
}
if ($missing.Count -gt 0) {
  Write-Host '빌드에 필요한 것이 없습니다:'
  foreach ($m in $missing) { Write-Host "  - $($m.what):  winget install -e --id $($m.winget)" }
  Write-Host '한 번에 설치: 이 스크립트에 -InstallTools'
  exit 1
}
$need = (Select-String -Path "$Src\Cargo.toml" -Pattern '^rust-version = "(.*)"').Matches[0].Groups[1].Value
$have = ((rustc --version) -split ' ')[1]
if ([version]$have -lt [version]$need) {
  Write-Host "==> Rust $have < $need : rustup update stable"
  if (-not $Check) { rustup update stable }
}
if ($Check) { Write-Host "도구 준비됨: $(rustc --version), MSVC $(Find-Msvc), NASM $(Find-Nasm)"; exit 0 }
$nasm = Find-Nasm
if ($nasm) { $env:Path = "$(Split-Path -Parent $nasm);$env:Path" }
rustup target add $Target | Out-Null

# ---- build ----------------------------------------------------------------------------------------------
$ver = (Select-String -Path "$Src\Cargo.toml" -Pattern '^version = "(.*)"').Matches[0].Groups[1].Value
Write-Host "==> aidev-runner $ver win-$Arch 빌드 (처음에는 의존성 컴파일로 몇 분)"
Push-Location $Src
try {
  cargo build --release --locked --target $Target
  if ($LASTEXITCODE -ne 0) { throw "cargo build 실패 ($LASTEXITCODE)" }
} finally { Pop-Location }
$name = "aidev-runner-$ver-win-$Arch.exe"
$dist = Join-Path $Src 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist $name
Copy-Item -Force (Join-Path $Src "target\$Target\release\aidev-runner.exe") $out
$hash = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
$sums = Join-Path $dist 'SHA256SUMS'
$lines = @(if (Test-Path $sums) { Get-Content $sums | Where-Object { $_ -notmatch " $([regex]::Escape($name))$" } }) + "$hash  $name"
Set-Content -Path $sums -Value $lines -Encoding ascii
& $out --version
Write-Host "==> $out"
if ($Install) {
  $p = @{ File = $out }
  if ($Code) { $p.Code = $Code }; if ($Gateway) { $p.Gateway = $Gateway }; if ($Name) { $p.Name = $Name }
  & (Join-Path $PSScriptRoot 'install-windows.ps1') @p
  exit $LASTEXITCODE
}
Write-Host "설치: powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -File `"$out`" [-Code <페어링 코드>]"
