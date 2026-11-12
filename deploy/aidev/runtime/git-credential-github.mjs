// Git credential helper for github.com in a runtime: answers with the GitHub account the user already connected in
// the app (the newest active `github_token` credential — "GitHub로 로그인" stores one), so an agent's `git push` does not
// ask for a second login. entrypoint.mjs adds it after the user's own helpers; only `get` is answered, and no answer
// (no connected account, unreadable database) leaves git to its next helper or its usual failure.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const input = fs.readFileSync(0, 'utf8');
if (process.argv[2] === 'get' && /^host=github\.com$/m.test(input)) {
  try {
    const Database = createRequire('/srv/app/current/')('better-sqlite3');
    const db = new Database(process.env.DATABASE_PATH || '/home/cloudcli/.cloudcli/auth.db', { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT credential_value FROM user_credentials WHERE credential_type = 'github_token' AND is_active = 1 ORDER BY created_at DESC, id DESC LIMIT 1").get();
    db.close();
    if (row?.credential_value) process.stdout.write(`username=x-access-token\npassword=${row.credential_value}\n`);
  } catch { /* no answer */ }
}
