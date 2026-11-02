#!/usr/bin/env bash
# Every account's projects folder on the AI-PC host at /data/docker_data/workspaces/<username>, so files can be
# copied in and out (scp/sftp as turtlelab) without entering the runtime container. A symlink cannot do it: the
# volumes sit under /var/lib/docker (root 0710) and belong to the runtime user. bindfs shows them owned by the host
# user and writes back as the runtime user. The folder is the one the runtime opens projects in: ~/workspaces when it
# exists, else home (PROJECTS_HOME in server/shared/utils.ts). Accounts are re-read every 5s, so an account added,
# deleted, disabled or renamed (admin page or manage-users) gets or loses its folder by itself.
#   workspace-share.sh install   -> build the image and (re)create the aidev-workspace-share container
#   workspace-share.sh status    -> container state and the shared folders
#   workspace-share.sh remove    -> stop sharing (unmounts, removes the empty folders)
#   workspace-share.sh run       -> the loop inside the container
set -uo pipefail
NAME=aidev-workspace-share IMAGE=aidev/workspace-share:latest
SHARE=${WORKSPACE_SHARE_DIR:-/data/docker_data/workspaces}
RUNTIME_UID=1001 HOST_UID=${HOST_UID:-$(id -u)}

mounts() { awk '$2 ~ "^/ws/" { print $2 }' /proc/mounts; }
source_of() { awk -v d="$1" '$2 == d { print $1 }' /proc/mounts; }
sync_once() {
  local want user runtime home src dst
  want=$(sqlite3 -separator ' ' 'file:/auth/auth.db?mode=ro' 'select username, runtime from accounts where active = 1 and runtime is not null') || return
  while read -r user runtime; do
    [[ "$user" =~ ^[a-z0-9_.-]{3,64}$ && "$runtime" =~ ^[A-Za-z0-9_-]+$ ]] || continue
    home=/vols/aidev_$runtime-home/_data
    [ -d "$home" ] || continue
    src=$home; [ -d "$home/workspaces" ] && src=$home/workspaces
    dst=/ws/$user
    if [ -n "$(source_of "$dst")" ]; then
      [ "$(source_of "$dst")" = "$src" ] && stat "$dst" >/dev/null 2>&1 && continue
      umount -l "$dst"   # stale (the container restarted) or the projects folder moved
    fi
    # no attribute cache: the runtime writes behind bindfs' back, a cached size would cut a fresh file short
    mkdir -p "$dst" && bindfs -o allow_other,attr_timeout=0,entry_timeout=0 --map="$RUNTIME_UID/$HOST_UID:@$RUNTIME_UID/@$HOST_UID" "$src" "$dst" && echo "shared $user <- $src"
  done <<< "$want"
  for dst in /ws/*; do
    [ -d "$dst" ] || continue
    cut -d' ' -f1 <<< "$want" | grep -qxF "${dst#/ws/}" && continue
    [ -n "$(source_of "$dst")" ] && umount -l "$dst"
    rmdir "$dst" 2>/dev/null && echo "unshared ${dst#/ws/}"   # never deletes files: only an empty mount point
  done
}

case "${1:-}" in
  run)
    trap 'for d in $(mounts); do umount -l "$d"; rmdir "$d" 2>/dev/null; done; exit 0' TERM INT
    while true; do sync_once; sleep 5 & wait $!; done ;;
  install)
    docker build -q -t "$IMAGE" - <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bindfs sqlite3 && rm -rf /var/lib/apt/lists/*
EOF
    mkdir -p "$SHARE"
    docker stop "$NAME" >/dev/null 2>&1; docker rm "$NAME" >/dev/null 2>&1   # stop, not rm -f: SIGTERM unmounts
    # FUSE needs SYS_ADMIN, /dev/fuse and no AppArmor mount rule; rshared carries the mounts out to the host
    docker run -d --name "$NAME" --restart unless-stopped --cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor=unconfined \
      -e HOST_UID="$HOST_UID" -v "$(realpath "$0")":/workspace-share.sh:ro -v aidev_auth-data:/auth:ro \
      -v /var/lib/docker/volumes:/vols -v "$SHARE":/ws:rshared "$IMAGE" bash /workspace-share.sh run >/dev/null
    sleep 3; docker logs "$NAME" ;;
  status) docker ps -a --filter "name=^$NAME$" --format '{{.Names}} {{.Status}}'; ls -la "$SHARE" ;;
  remove) docker stop "$NAME" >/dev/null 2>&1; docker rm "$NAME" >/dev/null 2>&1; ls -la "$SHARE" ;;
  *) echo "usage: workspace-share.sh install|status|remove" >&2; exit 1 ;;
esac
