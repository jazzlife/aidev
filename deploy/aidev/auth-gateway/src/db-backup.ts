import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Online SQLite backup (consistent snapshot via the backup API, safe while the gateway writes).
 *   node dist/db-backup.js [keepDays=7]   -> /data/backup/auth-YYYYMMDD-HHMMSS.db, prunes older copies
 * Run from the host with deploy/aidev/release/db-backup.sh (docker exec into aidev-auth-gateway).
 */
const source = process.env.DATABASE_PATH ?? '/data/auth.db';
const dir = process.env.BACKUP_DIR ?? path.join(path.dirname(source), 'backup');
const keepDays = Number(process.argv[2] ?? process.env.BACKUP_KEEP_DAYS ?? 7);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const target = path.join(dir, `auth-${stamp}.db`);
const db = new Database(source, { readonly: true });
await db.backup(target);
db.close();
const size = fs.statSync(target).size;
let pruned = 0;
for (const f of fs.readdirSync(dir)) {
  if (!/^auth-\d{8}-\d{6}\.db$/.test(f)) continue;
  const full = path.join(dir, f);
  if (Date.now() - fs.statSync(full).mtimeMs > keepDays * 86400_000) { fs.unlinkSync(full); pruned++; }
}
console.log(JSON.stringify({ backup: target, bytes: size, pruned, keepDays }));
