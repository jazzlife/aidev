#!/usr/bin/env bash
# Builds aidev-jdi.jar (the runner's JVM debug adapter, embedded with include_bytes!). Needs a JDK ≥ 11.
set -euo pipefail
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
javac --release 11 -Xlint:all -Werror -d "$out" AidevJdi.java
printf 'Manifest-Version: 1.0\nMain-Class: AidevJdi\nImplementation-Version: %s\n' "$(sed -n 's/.*VERSION = "\(.*\)";/\1/p' AidevJdi.java)" > "$out/MANIFEST.MF"
# reproducible: fixed timestamps, sorted entries
find "$out" -exec touch -d '2026-01-01T00:00:00Z' {} +
(cd "$out" && jar --create --file aidev-jdi.jar --manifest MANIFEST.MF --date=2026-01-01T00:00:00Z $(ls *.class | sort))
cp "$out/aidev-jdi.jar" aidev-jdi.jar
sha256sum aidev-jdi.jar
