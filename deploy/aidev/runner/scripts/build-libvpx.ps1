<#
.SYNOPSIS
  Windows: static libvpx — the VP9 encoder only — for the runner's `vpx` feature (F-18):
  vendor\libvpx\<rust target>\lib\vpx.lib.

.DESCRIPTION
  libvpx's own Visual Studio 2022 project build (/MD, the C runtime Rust links by default). Needs Git, Visual Studio
  2022 with C++ (and its ARM64 build tools for -Arch arm64) and MSYS2 at C:\msys64 for libvpx's configure script; make,
  diffutils and yasm (the x64 assembly: libvpx's project files call yasm) are added to MSYS2 here.
  The version is pinned: src\vpx_ffi.rs (bindgen) is generated from its headers. scripts/build-libvpx.sh: Linux, macOS.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-libvpx.ps1 -Arch arm64
#>
[CmdletBinding()]
param([ValidateSet('x64', 'arm64')] [string] $Arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }))
$ErrorActionPreference = 'Stop'
$Version = 'v1.17.0'
$Root = Split-Path -Parent $PSScriptRoot
$Triple = if ($Arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
$Out = Join-Path $Root "vendor\libvpx\$Triple"
if ((Test-Path "$Out\lib\vpx.lib") -and ((Get-Content "$Out\VERSION" -ErrorAction SilentlyContinue) -eq $Version)) { Write-Host "libvpx $Version ($Triple): $Out"; exit 0 }

$Src = Join-Path $Root "vendor\libvpx\src-$Version"
if (-not (Test-Path $Src)) {
  git clone -q --depth 1 --branch $Version https://chromium.googlesource.com/webm/libvpx $Src 2>&1 | Out-Null
  if ($LASTEXITCODE) { throw "libvpx $Version 을(를) 받지 못했습니다 (git clone)" }
}
$Msys = 'C:\msys64'
if (-not (Test-Path "$Msys\usr\bin\bash.exe")) { throw 'MSYS2가 필요합니다 (C:\msys64) — winget install -e --id MSYS2.MSYS2' }
& "$Msys\usr\bin\pacman.exe" -S --noconfirm --needed make diffutils mingw-w64-x86_64-yasm 2>&1 | Out-Null
if ($LASTEXITCODE) { throw 'MSYS2에 make / diffutils / yasm 을 설치하지 못했습니다 (pacman)' }
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1 }
if (-not $msbuild) { throw 'Visual Studio 2022 (MSBuild)가 필요합니다' }

$work = Join-Path ([IO.Path]::GetTempPath()) ("libvpx-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$target = if ($Arch -eq 'arm64') { 'arm64-win64-vs17' } else { 'x86_64-win64-vs17 --as=yasm' }
# MSYS2's tools first, then MSBuild (libvpx's make calls msbuild.exe) and everything else this shell has
$env:PATH = "$Msys\usr\bin;$Msys\mingw64\bin;$(Split-Path -Parent $msbuild);$env:PATH"
$env:MSYS2_PATH_TYPE = 'inherit'
$srcU = (& "$Msys\usr\bin\cygpath.exe" -u $Src).Trim()
$workU = (& "$Msys\usr\bin\cygpath.exe" -u $work).Trim()
$sh = "cd '$workU' && '$srcU/configure' --target=$target " +
  '--disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-webm-io --disable-libyuv ' +
  '--disable-vp8 --enable-vp9 --disable-vp9-decoder --enable-vp9-encoder --enable-realtime-only --enable-runtime-cpu-detect ' +
  '> configure.log 2>&1 || { tail -30 configure.log; exit 1; }; make -j4 > make.log 2>&1 || { tail -60 make.log; exit 1; }'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& "$Msys\usr\bin\bash.exe" --noprofile --norc -c $sh 2>&1 | ForEach-Object { Write-Host $_.ToString() }
$code = $LASTEXITCODE; $ErrorActionPreference = $prev
if ($code) { throw "libvpx 빌드 실패 ($code) — $work" }
$lib = Get-ChildItem $work -Recurse -Filter 'vpxmd.lib' | Where-Object { $_.FullName -match '\\Release\\' } | Select-Object -First 1
if (-not $lib) { throw "vpxmd.lib 이 만들어지지 않았습니다 — $work\make.log" }
New-Item -ItemType Directory -Force "$Out\lib" | Out-Null
Copy-Item -Force $lib.FullName "$Out\lib\vpx.lib"
Set-Content "$Out\VERSION" $Version -NoNewline
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
Write-Host "libvpx $Version ($Triple): $Out"
