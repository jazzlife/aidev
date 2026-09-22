import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Gateway server and offline administration share this persistent identity store. */
export function openStore(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, runtime TEXT UNIQUE NOT NULL,
      active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS gateway_sessions (
      sid TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
  `);
  type Account = { id: number; username: string; password_hash: string; runtime: string; active: number };
  return {
    db,
    account(username: string) { return db.prepare('SELECT * FROM accounts WHERE username=?').get(username) as Account | undefined; },
    session(sid: string) {
      return db.prepare(`SELECT a.* FROM accounts a JOIN gateway_sessions s ON s.user_id=a.id
        WHERE s.sid=? AND s.expires>? AND a.active=1`).get(sid, Date.now()) as Account | undefined;
    },
    issue(userId: number, expires: number) {
      const sid = crypto.randomBytes(32).toString('hex');
      db.prepare('DELETE FROM gateway_sessions WHERE expires<=?').run(Date.now());
      db.prepare('INSERT INTO gateway_sessions VALUES(?,?,?)').run(sid, userId, expires);
      return sid;
    },
    revoke(sid: string) { db.prepare('DELETE FROM gateway_sessions WHERE sid=?').run(sid); },
    async check(password: string, encoded: string) {
      const [salt, hash] = encoded.split(':');
      const derived = await derive(password, salt);
      const expected = Buffer.from(hash, 'hex');
      return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    },
    async add(username: string, password: string, runtime: string, active = 1) {
      if (!/^[a-z0-9_.-]{3,64}$/.test(username) || password.length < 4 || password.length > 256) throw new Error('Use a lowercase username and a password of 4–256 characters');
      const salt = crypto.randomBytes(16).toString('hex');
      const encoded = `${salt}:${(await derive(password, salt)).toString('hex')}`;
      db.prepare('INSERT INTO accounts(username,password_hash,runtime,active) VALUES(?,?,?,?)').run(username, encoded, runtime, active);
    },
    remove(username: string) {
      db.transaction(() => {
        db.prepare('DELETE FROM gateway_sessions WHERE user_id IN (SELECT id FROM accounts WHERE username=?)').run(username);
        db.prepare('DELETE FROM accounts WHERE username=?').run(username);
      })();
    },
    disable(username: string) {
      db.transaction(() => {
        db.prepare('DELETE FROM gateway_sessions WHERE user_id IN (SELECT id FROM accounts WHERE username=?)').run(username);
        db.prepare('UPDATE accounts SET active=0 WHERE username=?').run(username);
      })();
    },
  };
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, hash) => error ? reject(error) : resolve(hash)));
}
