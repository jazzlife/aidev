#!/usr/bin/env bash
# One partial update, end to end, on the AI-PC:
#   deploy.sh <release-<sha>.tgz>
# 1. install   (unpack; build deps only if a lockfile changed — usually a no-op)
# 2. diff      (which components differ from the active release)
# 3. activate  (atomic `current` swap)
# 4. restart   (only the processes whose code changed: gateway / runtime-manager / runtimes)
# A frontend-only release therefore restarts nothing; users get it on their next page load.
# Rollback: release.sh rollback && release.sh restart <same set>.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); R="$here/release.sh"
tgz="${1:?release tgz, or - to read it from stdin}"; shift || true
if [ "$tgz" = "-" ]; then  # direct SSH stream: cat release.tgz | ssh host deploy.sh -
  spool=$(mktemp /tmp/aidev-release-XXXXXX.tgz); cat > "$spool"; tgz="$spool"; trap 'rm -f "$spool"' EXIT
  [ -s "$tgz" ] || { echo "empty stream"; exit 1; }
fi
# Runtime restart policy for large fleets. Default: 6 in parallel, idle runtimes first,
# runtimes with live WebSocket sessions deferred (finish later with `release.sh restart --drain runtimes`).
# Override per deploy:  deploy.sh <tgz> --batch 10 --force      (or set RESTART_OPTS)
RESTART_OPTS="${RESTART_OPTS:---drain --batch 6}"; [ $# -gt 0 ] && RESTART_OPTS="$*"
# Hold the host-wide release lock for the whole deploy; nested release.sh calls inherit it.
if [ -z "${AIDEV_RELEASE_LOCKED:-}" ]; then exec env AIDEV_RELEASE_LOCKED=1 AIDEV_SPOOL="${spool:-}" flock -w 600 /tmp/aidev-release.lock "$0" "$tgz" "$@"; fi
[ -n "${AIDEV_SPOOL:-}" ] && trap 'rm -f "$AIDEV_SPOOL"' EXIT
sha=$("$R" install "$tgz" | tail -1)
prev=$(docker run --rm -v aidev_app:/srv/app node:22-bookworm-slim sh -c 'readlink /srv/app/current 2>/dev/null | sed "s#releases/##"' </dev/null || true)
if [ "$prev" = "$sha" ]; then echo "release $sha is already active"; exit 0; fi
if [ -n "$prev" ]; then
  changed=$("$R" diff "$prev" "$sha" | tr '\n' ' ')
else
  changed="frontend server gateway runtime-manager"
fi
echo "==> $prev -> $sha ; changed: ${changed:-nothing}"
"$R" activate "$sha"
restart=""
case " $changed " in *" runtime-manager "*) restart="$restart runtime-manager";; esac
case " $changed " in *" gateway "*)         restart="$restart gateway";; esac
case " $changed " in *" server "*)          restart="$restart runtimes";; esac
if [ -n "$restart" ]; then "$R" restart $RESTART_OPTS $restart; else echo " ✓ frontend-only release: no process restarted"; fi
"$R" status
echo "DEPLOYED_RELEASE=$sha"
