<#
.SYNOPSIS
  Windows: build aidev-clrdbg (the .NET Framework debug adapter) natively and publish it for runners.

.DESCRIPTION
  Same result as build.sh: <Out>\aidev-clrdbg-<ver>-win32-x64.zip (aidev-clrdbg.exe for 64-bit/AnyCPU debuggees,
  aidev-clrdbg-x86.exe for 32-bit) and <Out>\manifest.json ("clrdbg-win32-x64"), which the gateway serves at
  /_runner/adapters/ (release: runner\dist\adapters). Needs the .NET SDK (winget install Microsoft.DotNet.SDK.8);
  the .NET Framework 4.7.2 reference assemblies come from NuGet. debugger-libs and mono-debug are downloaded and
  checked unless given.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\aidev\clrdbg\build.ps1 -Out deploy\aidev\runner\dist\adapters
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $Out,
  [string] $DebuggerLibsSrc,
  [string] $MonoDebugVsix
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
$Version = '1.0.0'
$LibsCommit = 'e7fbb713d156d11193ed404783ad6fe9c4042a6d'
$VsixSha256 = 'a9a6b460583f81f96077bdec636671058ca89fd4b4b07fec3c77a2bcf60deace'
$here = $PSScriptRoot
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET SDK가 필요합니다: winget install -e --id Microsoft.DotNet.SDK.8' }
New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("clrdbg-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $work | Out-Null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if (-not $DebuggerLibsSrc) {
    Invoke-WebRequest -UseBasicParsing "https://github.com/mono/debugger-libs/archive/$LibsCommit.zip" -OutFile "$work\libs.zip"
    Expand-Archive "$work\libs.zip" -DestinationPath $work
    $DebuggerLibsSrc = Join-Path $work "debugger-libs-$LibsCommit"
  }
  if (-not $MonoDebugVsix) {
    $MonoDebugVsix = "$work\mono-debug.vsix"
    Invoke-WebRequest -UseBasicParsing 'https://github.com/microsoft/vscode-mono-debug/releases/download/v0.16.3/mono-debug-0.16.3.vsix' -OutFile $MonoDebugVsix
  }
  $got = (Get-FileHash -Algorithm SHA256 $MonoDebugVsix).Hash.ToLower()
  if ($got -ne $VsixSha256) { throw "mono-debug vsix SHA-256이 다릅니다 ($got)" }
  $lib = "$work\lib"; New-Item -ItemType Directory -Force $lib | Out-Null
  Copy-Item $MonoDebugVsix "$work\vsix.zip"
  Expand-Archive "$work\vsix.zip" -DestinationPath "$work\vsix"
  Copy-Item "$work\vsix\extension\bin\Release\*.dll" $lib
  Remove-Item "$lib\Mono.Debugging.Soft.dll", "$lib\Mono.Debugger.Soft.dll", "$lib\Mono.Cecil*.dll" -ErrorAction SilentlyContinue

  $props = @("-p:DebuggerLibs=$DebuggerLibsSrc", "-p:ClrLibs=$lib", '-nologo', '-v:q', '-c', 'Release')
  if ((Invoke-Native dotnet (@('build', "$here\libs\Mono.Debugging.Win32.csproj") + $props)) -ne 0) { throw 'debugger-libs 빌드 실패' }
  $pkg = "$work\pkg"
  if ((Invoke-Native dotnet (@('build', "$here\aidev-clrdbg.csproj") + $props + @('-o', $pkg))) -ne 0) { throw 'aidev-clrdbg 빌드 실패' }
  if ((Invoke-Native dotnet (@('build', "$here\aidev-clrdbg.csproj") + $props + @('-p:PlatformTarget=x86', '-p:AssemblyName=aidev-clrdbg-x86', '-o', "$work\x86"))) -ne 0) { throw 'aidev-clrdbg (x86) 빌드 실패' }
  Copy-Item "$work\x86\aidev-clrdbg-x86.exe", "$work\x86\aidev-clrdbg-x86.exe.config" $pkg
  Copy-Item "$lib\*.dll" $pkg -Force
  Copy-Item "$here\LICENSE-vscode-mono-debug.txt", "$here\LICENSE-debugger-libs.txt" $pkg
  Remove-Item "$pkg\*.pdb" -ErrorAction SilentlyContinue
  $zipName = "aidev-clrdbg-$Version-win32-x64.zip"
  $zip = Join-Path $Out $zipName
  Remove-Item $zip -ErrorAction SilentlyContinue
  Compress-Archive -Path "$pkg\*" -DestinationPath $zip
  $sha = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  $manifestPath = Join-Path $Out 'manifest.json'
  $m = if (Test-Path $manifestPath) { Get-Content $manifestPath -Raw | ConvertFrom-Json } else { New-Object PSObject }
  $entry = [pscustomobject]@{ file = $zipName; sha256 = $sha; version = $Version }
  $m | Add-Member -NotePropertyName 'clrdbg-win32-x64' -NotePropertyValue $entry -Force
  $m | ConvertTo-Json -Depth 5 | Set-Content -Encoding ascii $manifestPath
  Write-Host "$sha  $zipName"
  # quick self-check: the adapter answers initialize (it runs on this Windows PC)
  $exe = Join-Path $pkg 'aidev-clrdbg.exe'
  $req = '{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"clr","linesStartAt1":true,"pathFormat":"path"}}'
  $psi = New-Object Diagnostics.ProcessStartInfo $exe
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.UseShellExecute = $false
  $proc = [Diagnostics.Process]::Start($psi)
  # raw bytes on the base stream: the StreamWriter would start with a UTF-8 BOM (Windows PowerShell 5.1), which
  # shifts the body for the adapter's header parser (character index used as byte offset) and truncates the JSON
  $bytes = [Text.Encoding]::UTF8.GetBytes("Content-Length: $([Text.Encoding]::UTF8.GetByteCount($req))`r`n`r`n$req")
  $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length); $proc.StandardInput.BaseStream.Flush()
  $task = $proc.StandardOutput.ReadLineAsync()
  $answered = $task.Wait(15000) -and $task.Result -match 'Content-Length'
  if (-not $proc.HasExited) { $proc.Kill() }
  if (-not $answered) { throw 'aidev-clrdbg가 DAP initialize에 응답하지 않습니다' }
  Write-Host ' ✓ aidev-clrdbg가 DAP initialize에 응답합니다'
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
