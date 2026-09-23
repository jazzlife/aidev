#!/usr/bin/env bash
# Gateway SQLite backup on the AI-PC (online, consistent). Backups live in the auth-data volume
# under /data/backup and are pruned after 7 days.
#   db-backup.sh            -> take one backup now
#   db-backup.sh install    -> install a daily 03:30 cron entry for the turtlelab user
#   db-backup.sh list       -> list backups
#   db-backup.sh restore F  -> stop gateway, replace /data/auth.db with backup F (basename), start gateway
set -euo pipefail
GW=aidev-auth-gateway
DEPLOY=${DEPLOY_DIR:-/home/turtlelab/aidev/deploy}
case "${1:-run}" in
  run) docker exec "$GW" node /srv/app/current/control/gateway/dist/db-backup.js "${2:-7}" ;;
  list) docker exec "$GW" sh -c 'ls -l /data/backup 2>/dev/null || echo "(no backups)"' ;;
  install)
    line="30 3 * * * /usr/bin/env bash $DEPLOY/release/db-backup.sh run >> $DEPLOY/db-backup.log 2>&1"
    ( crontab -l 2>/dev/null | grep -v 'db-backup.sh' ; echo "$line" ) | crontab -
    echo "installed: $line" ;;
  restore)
    f=${2:?backup basename required}; [[ "$f" =~ ^auth-[0-9]{8}-[0-9]{6}\.db$ ]] || { echo "bad backup name" >&2; exit 1; }
    docker exec "$GW" test -f "/data/backup/$f" || { echo "missing /data/backup/$f" >&2; exit 1; }
    ( cd "$DEPLOY" && docker compose stop auth-gateway )
    docker run --rm -v aidev_auth-data:/data node:22-bookworm-slim sh -c "cp /data/auth.db /data/auth.db.before-restore && rm -f /data/auth.db-wal /data/auth.db-shm && cp /data/backup/$f /data/auth.db && chown 1001:1001 /data/auth.db"
    ( cd "$DEPLOY" && docker compose start auth-gateway )
    echo "restored $f (previous copy kept as /data/auth.db.before-restore)" ;;
  *) echo "usage: db-backup.sh [run [keepDays]|list|install|restore FILE]" >&2; exit 1 ;;
esac
