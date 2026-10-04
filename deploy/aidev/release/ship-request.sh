#!/usr/bin/env bash
# OPS-02: ask the platform to ship itself and follow it, ON the AI-PC (no build or deploy happens here — ship.sh runs
# in runtime-manager's aidev-ship-<id> container). For people and tools outside NadoVibe's chat (an admin's agent uses
# the platform_ship tool instead); `ops/relay.sh ship <user> [ref]` streams this from the Mac.
#   ship-request.sh <admin user> [ref=main]      ships GitHub <ref> (it must continue GitHub main)
# No password: a 10-minute gateway session is minted inside the gateway container and revoked at the end.
set -uo pipefail
main() {
  local user="${1:?admin username}" ref="${2:-main}"
  local GW=http://aidev-auth-gateway:8080 CURL="docker run --rm --network npm_bridge curlimages/curl:8.16.0 -sS -m 30"
  local MU="docker exec aidev-auth-gateway node /srv/app/current/control/gateway/dist/manage-users.js"
  local TOK SID
  read -r TOK SID < <($MU session "$user" 2>/dev/null | tail -1)
  [ -n "${TOK:-}" ] && [ -n "${SID:-}" ] || { echo " ✗ no session for $user"; return 1; }
  trap "$MU end-session '$SID' >/dev/null 2>&1" RETURN
  local r id
  r=$($CURL -X POST -H "authorization: Bearer $TOK" -H 'content-type: application/json' --data-binary "{\"ref\":\"$ref\"}" "$GW/api/aidev/platform/ship")
  id=$(echo "$r" | sed -n 's/.*"id":"\([a-z0-9]*\)".*/\1/p')
  [ -n "$id" ] || { echo " ✗ ship refused: $r"; return 1; }
  echo "==> ship $id ($ref) — following aidev-ship-$id"
  local step="" now
  for _ in $(seq 1 360); do
    now=$(docker logs "aidev-ship-$id" 2>&1 | tr -d '\r' | grep -a '^SHIP_STEP' | tail -1)
    [ "$now" = "$step" ] || { step=$now; echo "    ${step#SHIP_STEP }"; }
    docker logs "aidev-ship-$id" 2>&1 | grep -aq '^SHIP_RESULT' && break
    [ "$(docker inspect -f '{{.State.Running}}' "aidev-ship-$id" 2>/dev/null)" = true ] || break
    sleep 5
  done
  local result; result=$(docker logs "aidev-ship-$id" 2>&1 | tr -d '\r' | grep -a '^SHIP_RESULT' | tail -1)
  if [ -z "$result" ] || ! echo "$result" | grep -q '^SHIP_RESULT ok '; then
    echo "== log tail"; docker logs "aidev-ship-$id" 2>&1 | tr -d '\r' | grep -av '^\s*$' | tail -40
  fi
  echo "${result:-SHIP_RESULT failed none ship ended without a result}"
  echo "$result" | grep -q '^SHIP_RESULT ok '
}
main "$@" </dev/null
