#!/usr/bin/env bash
# Builds aidev-clrdbg (DAP adapter for .NET Framework 2.0–4.8 on Windows) and publishes it for runners:
#   <out>/aidev-clrdbg-<ver>-win32-x64.zip  (aidev-clrdbg.exe = 64-bit/AnyCPU debuggees, aidev-clrdbg-x86.exe = 32-bit)
#   <out>/manifest.json                      entry "clrdbg-win32-x64": {file, sha256, version}
# The gateway serves <out> at /_runner/adapters/ (RUNNER_ADAPTERS_DIR; release: runner/dist/adapters → control/runner/adapters).
#
#   ./build.sh <out-dir>
# Inputs (downloaded and SHA-256-checked unless given): DEBUGGER_LIBS_SRC=<debugger-libs checkout @ commit below>,
# MONO_DEBUG_VSIX=<mono-debug-0.16.3.vsix> (its Mono.Debugging + dependencies). Needs the .NET SDK; off Windows
# also Mono's reference assemblies (FrameworkPathOverride, default /usr/lib/mono/4.7.2-api).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "${1:?usage: build.sh <out-dir>}" && cd "$1" && pwd)
VERSION=1.0.0
LIBS_COMMIT=e7fbb713d156d11193ed404783ad6fe9c4042a6d
VSIX_SHA256=a9a6b460583f81f96077bdec636671058ca89fd4b4b07fec3c77a2bcf60deace
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

src=${DEBUGGER_LIBS_SRC:-}
if [ -z "$src" ]; then
  curl -fsSL "https://github.com/mono/debugger-libs/archive/$LIBS_COMMIT.tar.gz" -o "$work/libs.tgz"
  tar -xzf "$work/libs.tgz" -C "$work"; src="$work/debugger-libs-$LIBS_COMMIT"
fi
vsix=${MONO_DEBUG_VSIX:-}
if [ -z "$vsix" ]; then
  vsix="$work/mono-debug.vsix"
  curl -fsSL "https://github.com/microsoft/vscode-mono-debug/releases/download/v0.16.3/mono-debug-0.16.3.vsix" -o "$vsix"
fi
echo "$VSIX_SHA256  $vsix" | sha256sum -c - >/dev/null
lib="$work/lib"; mkdir -p "$lib" "$work/vsix"
unzip -q "$vsix" 'extension/bin/Release/*' -d "$work/vsix"
cp "$work/vsix/extension/bin/Release/"*.dll "$lib/"
rm -f "$lib/Mono.Debugging.Soft.dll" "$lib/Mono.Debugger.Soft.dll" "$lib/Mono.Cecil"*.dll

props=(-p:DebuggerLibs="$src" -p:ClrLibs="$lib" -nologo -v:q -c Release)
if [ "$(uname -s)" != "MINGW64_NT"* ] && [ -z "${WINDIR:-}" ]; then props+=(-p:FrameworkPathOverride="${FrameworkPathOverride:-/usr/lib/mono/4.7.2-api}"); fi
printf '<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSources><clear /></packageSources></configuration>\n' > "$work/nuget.config"
cp "$work/nuget.config" "$here/libs/nuget.config"; cp "$work/nuget.config" "$here/nuget.config"
trap 'rm -rf "$work" "$here/libs/nuget.config" "$here/nuget.config" "$here/libs/obj" "$here/obj" "$here/bin"' EXIT
dotnet build "$here/libs/Mono.Debugging.Win32.csproj" "${props[@]}"
pkg="$work/pkg"; mkdir -p "$pkg"
dotnet build "$here/aidev-clrdbg.csproj" "${props[@]}" -o "$pkg"
dotnet build "$here/aidev-clrdbg.csproj" "${props[@]}" -p:PlatformTarget=x86 -p:AssemblyName=aidev-clrdbg-x86 -o "$work/x86"
cp "$work/x86/aidev-clrdbg-x86.exe" "$work/x86/aidev-clrdbg-x86.exe.config" "$pkg/"
cp "$lib/"*.dll "$pkg/"
cp "$here/LICENSE-vscode-mono-debug.txt" "$here/LICENSE-debugger-libs.txt" "$pkg/"
rm -f "$pkg/"*.pdb
zipname="aidev-clrdbg-$VERSION-win32-x64.zip"
(cd "$pkg" && find . -type f -exec touch -d '2026-01-01T00:00:00Z' {} + && rm -f "$out/$zipname" && zip -qX -r "$out/$zipname" $(ls | sort))
sha=$(sha256sum "$out/$zipname" | cut -d' ' -f1)
node -e '
const fs = require("fs"); const [file, sha, version, path] = process.argv.slice(1);
const m = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
m["clrdbg-win32-x64"] = { file, sha256: sha, version };
fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");' "$zipname" "$sha" "$VERSION" "$out/manifest.json"
echo "$sha  $zipname"
