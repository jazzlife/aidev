#!/usr/bin/env bash
# Lane A — frontend release. No image build, no container restart, no downtime.
#   frontend.sh <dist.tgz> <release-id>     install a prebuilt Vite dist and switch to it
#   frontend.sh --rollback [release-id]     switch `current` back (default: previous)
#   frontend.sh --list
# The volume holds releases/<id>/ and a `current` symlink that the gateway
# re-resolves on every request, so the swap is atomic for users.
. "$(dirname "$0")/lib.sh"

helper() { # run a command inside a throwaway container with the volume mounted rw
  docker run --rm -i -v "$FRONTEND_VOLUME:/srv/frontend" -w /srv/frontend node:22-bookworm-slim sh -c "$1"
}

case "${1:-}" in
  --list)
    helper 'ls -1 releases 2>/dev/null; printf "current -> %s\n" "$(readlink current 2>/dev/null)"' ;;
  --rollback)
    target="${2:-}"
    [ -n "$target" ] || target=$(helper 'cat previous 2>/dev/null')
    [ -n "$target" ] || fail "no previous release recorded"
    helper "test -f releases/$target/index.html" || fail "release $target not found"
    helper "cur=\$(readlink current); ln -sfn releases/$target current.tmp && mv -Tf current.tmp current && echo \"\${cur#releases/}\" > previous"
    ok "frontend rolled back to $target" ;;
  *)
    dist="${1:-}"; id="${2:-}"
    [ -f "$dist" ] && [ -n "$id" ] || fail "usage: frontend.sh <dist.tgz> <release-id> | --rollback [id] | --list"
    tar tzf "$dist" | grep -qx 'index.html' || fail "$dist does not contain index.html at its root"
    log "installing frontend release $id"
    # Populate the new release dir fully before it becomes visible via `current`.
    helper "rm -rf releases/$id.partial && mkdir -p releases/$id.partial && chown 1001:1001 releases/$id.partial"
    docker run --rm -i -v "$FRONTEND_VOLUME:/srv/frontend" -w "/srv/frontend/releases/$id.partial" node:22-bookworm-slim tar xzf - < "$dist"
    helper "chown -R 1001:1001 releases/$id.partial && rm -rf releases/$id && mv releases/$id.partial releases/$id \
      && cur=\$(readlink current 2>/dev/null || true); ln -sfn releases/$id current.tmp && mv -Tf current.tmp current \
      && { [ -n \"\$cur\" ] && echo \"\${cur#releases/}\" > previous || true; } \
      && ls -1d releases/* | head -n -5 | xargs -r rm -rf"   # keep the 5 newest releases
    ok "frontend current -> $id"
    gateway_release || true ;;
esac
