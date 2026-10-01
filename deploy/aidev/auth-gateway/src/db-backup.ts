import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Online SQLite backup (consistent snapshot via the backup API, safe while the gateway writes).
 *   node dist/db-backup.js [keepDays=7]   -> /data/backup/auth-YYYYMMDD-HHMMSS.db, prunes older copies
 * The gateway also takes one a day itself (startBackupSchedule) — no host cron needed (B-17: the cron of
 * deploy/aidev/release/db-backup.sh install was never installed, so the last backups were from 2026-09-23).
 */
const DAY = 86_400_000;
const sourcePath = () => process.env.DATABASE_PATH ?? '/data/auth.db';
const backupDir = () => process.env.BACKUP_DIR ?? path.join(path.dirname(sourcePath()), 'backup');

/** One backup of `db` into the backup folder; copies older than `keepDays` are removed. */
export async function backupDatabase(db: Database.Database, keepDays = Number(process.env.BACKUP_KEEP_DAYS ?? 7)) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const target = path.join(dir, `auth-${stamp}.db`);
  await db.backup(target);
  const size = fs.statSync(target).size;
  let pruned = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^auth-\d{8}-\d{6}\.db$/.test(f)) continue;
    const full = path.join(dir, f);
    if (Date.now() - fs.statSync(full).mtimeMs > keepDays * DAY) { fs.unlinkSync(full); pruned++; }
  }
  return { backup: target, bytes: size, pruned, keepDays };
}

/** Used by the gateway entrypoint: a backup once a day (checked every 6 h; env AIDEV_DB_BACKUP=off disables). */
export function startBackupSchedule(store: { db: Database.Database; kvGet: (k: string) => string | null; kvSet: (k: string, v: string) => void }) {
  if (process.env.AIDEV_DB_BACKUP === 'off') { console.log('[aidev] db backup schedule off'); return; }
  const tick = async () => {
    if (Date.now() - Number(store.kvGet('db_backup_at') ?? 0) < DAY) return;
    try {
      const result = await backupDatabase(store.db);
      store.kvSet('db_backup_at', String(Date.now()));
      console.log(`[aidev] db backup ${path.basename(result.backup)} ${result.bytes} bytes, pruned ${result.pruned}`);
    } catch (error) { console.warn('[aidev] db backup failed:', error instanceof Error ? error.message : error); }
  };
  setTimeout(() => { void tick(); }, 60_000).unref();
  setInterval(() => { void tick(); }, 6 * 3600_000).unref();
}

// CLI (deploy/aidev/release/db-backup.sh run): a backup now from a read-only handle
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = new Database(sourcePath(), { readonly: true });
  const result = await backupDatabase(db, Number(process.argv[2] ?? process.env.BACKUP_KEEP_DAYS ?? 7));
  db.close();
  console.log(JSON.stringify(result));
}
