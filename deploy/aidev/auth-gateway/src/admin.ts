import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import jwt from 'jsonwebtoken';

import type { openStore } from './store.js';

/**
 * User administration at /admin (2026-10-12): its own sign-in — app_kv `admin.login` (username + scrypt hash), set on
 * the server with `manage-users admin-login USERNAME` (password on stdin), never in the repository — and a page to add,
 * rename, enable/disable, make admin, reset the password of, and delete accounts. A new account and a reset password
 * are INITIAL_PASSWORD with `must_change_password`: signing in with it asks for a new password first (/api/auth/login →
 * `password_change_required`, then /api/auth/change-password). Adding provisions the user's runtime container, deleting
 * removes it (volumes stay). The admin session is a separate host-only cookie, 8 hours.
 *   POST /admin/api/login {username, password} · POST /admin/api/logout · GET /admin/api/users
 *   POST /admin/api/users {username, role?} · PATCH /admin/api/users/:id {username?, role?, active?}
 *   POST /admin/api/users/:id/reset-password · DELETE /admin/api/users/:id
 */
type Store = ReturnType<typeof openStore>;
type Json = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
export const INITIAL_PASSWORD = '123456';
const COOKIE = '__Host-aidev-admin';
const TTL = 8 * 3600;
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
/** an account deleted while other rows still point at it: kept under this prefix, out of every list and sign-in */
const DELETED = 'deleted:';

export function createAdmin(deps: { store: Store; secret: string; origin: string; json: Json; provision: (runtime: string) => Promise<unknown>; removeRuntime: (runtime: string) => Promise<unknown> }) {
  const { store, secret, origin, json } = deps;
  const attempts = new Map<string, { count: number; until: number }>();
  const signed = (req: IncomingMessage) => {
    const token = (req.headers.cookie ?? '').split(';').map((v) => v.trim()).find((v) => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token) return false;
    try { const claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'aidev-admin', audience: origin }); return typeof claims !== 'string' && claims.admin === true; } catch { return false; }
  };
  const cookie = (token: string, age: number) => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
  async function readBody(req: IncomingMessage) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw Object.assign(new Error('Body exceeds 4KB'), { status: 413 }); }
    try { return (raw ? JSON.parse(raw) : {}) as Record<string, unknown>; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  }
  const users = () => (store.db.prepare(`SELECT id, username, active, role, must_change_password FROM accounts WHERE username NOT LIKE '${DELETED}%' ORDER BY id`).all() as Array<{ id: number; username: string; active: number; role: string; must_change_password: number }>)
    .map((u) => ({ id: u.id, username: u.username, active: Boolean(u.active), role: u.role, mustChangePassword: Boolean(u.must_change_password) }));
  const account = (id: number) => store.db.prepare(`SELECT id, username, runtime, active FROM accounts WHERE id=? AND username NOT LIKE '${DELETED}%'`).get(id) as { id: number; username: string; runtime: string; active: number } | undefined;
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const m = req.method ?? 'GET';
    if (url.pathname === '/admin/api/login' && m === 'POST') {
      const b = await readBody(req);
      const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      const now = Date.now();
      for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
      const entry = attempts.get('admin') ?? { count: 0, until: now + 15 * 60_000 };
      if (++entry.count > 10) return json(res, 429, { error: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' }, { 'retry-after': '60' });
      attempts.set('admin', entry);
      const login = (() => { try { return JSON.parse(store.kvGet('admin.login') ?? 'null') as { username: string; hash: string } | null; } catch { return null; } })();
      // the same hashing work whether or not the name matches
      const ok = password.length <= 256 && await store.check(password, login?.hash ?? `dummy:${'0'.repeat(128)}`) && Boolean(login) && login!.username === username;
      if (!ok) return json(res, 401, { error: login ? '아이디 또는 비밀번호가 올바르지 않습니다' : '관리자 계정이 설정되지 않았습니다 (서버에서 manage-users admin-login)' });
      attempts.delete('admin');
      console.log('[admin] signed in');
      const token = jwt.sign({ admin: true }, secret, { expiresIn: TTL, issuer: 'aidev-admin', audience: origin, algorithm: 'HS256' });
      return json(res, 200, { success: true }, { 'set-cookie': cookie(token, TTL) });
    }
    if (url.pathname === '/admin/api/logout' && m === 'POST') return json(res, 200, { success: true }, { 'set-cookie': cookie('', 0) });
    if (!signed(req)) return json(res, 401, { error: '관리자 로그인이 필요합니다' });
    if (url.pathname === '/admin/api/users' && m === 'GET') return json(res, 200, { users: users(), initialPassword: INITIAL_PASSWORD });
    if (url.pathname === '/admin/api/users' && m === 'POST') {
      const b = await readBody(req);
      const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
      if (!USERNAME.test(username)) throw fail(400, '아이디: 영문 소문자·숫자·_ . - 로 3~64자 (첫 글자는 영문·숫자)');
      if (store.account(username)) throw fail(409, '이미 있는 아이디입니다');
      const runtime = `u${crypto.randomBytes(12).toString('hex')}`;
      await store.add(username, INITIAL_PASSWORD, runtime, 0, true);
      try {
        await deps.provision(runtime);
      } catch (error) {
        try { await deps.removeRuntime(runtime); } catch { /* best effort */ }
        store.remove(username);
        throw fail(502, `실행 환경을 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
      store.db.prepare('UPDATE accounts SET active=1, role=? WHERE username=?').run(b.role === 'admin' ? 'admin' : 'user', username);
      console.log(`[admin] created ${username}`);
      return json(res, 201, { users: users() });
    }
    const one = url.pathname.match(/^\/admin\/api\/users\/(\d+)(\/reset-password)?$/);
    if (!one) return json(res, 404, { error: 'Not found' });
    const target = account(Number(one[1]));
    if (!target) throw fail(404, '사용자를 찾을 수 없습니다');
    if (one[2] && m === 'POST') {
      await store.setPassword(target.id, INITIAL_PASSWORD, true);
      console.log(`[admin] reset the password of ${target.username}`);
      return json(res, 200, { users: users() });
    }
    if (!one[2] && m === 'PATCH') {
      const b = await readBody(req);
      if (typeof b.username === 'string' && b.username.trim().toLowerCase() !== target.username) {
        const name = b.username.trim().toLowerCase();
        if (!USERNAME.test(name)) throw fail(400, '아이디: 영문 소문자·숫자·_ . - 로 3~64자 (첫 글자는 영문·숫자)');
        if (store.account(name)) throw fail(409, '이미 있는 아이디입니다');
        store.db.prepare('UPDATE accounts SET username=? WHERE id=?').run(name, target.id);
      }
      if (b.role === 'admin' || b.role === 'user') store.db.prepare('UPDATE accounts SET role=? WHERE id=?').run(b.role, target.id);
      if (b.active === false) store.disable(account(target.id)!.username);
      if (b.active === true) store.db.prepare('UPDATE accounts SET active=1 WHERE id=?').run(target.id);
      console.log(`[admin] updated ${target.username} ${JSON.stringify(b).slice(0, 200)}`);
      return json(res, 200, { users: users() });
    }
    if (!one[2] && m === 'DELETE') {
      store.disable(target.username);
      await deps.removeRuntime(target.runtime);
      try { store.remove(target.username); }
      catch {
        // its runs, PCs, decisions… still point at the row: keep it out of sight and out of reach, and free the name
        store.db.prepare('UPDATE accounts SET username=?, active=0 WHERE id=?').run(`${DELETED}${target.id}:${target.username}`, target.id);
      }
      console.log(`[admin] deleted ${target.username}`);
      return json(res, 200, { users: users() });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  return {
    /** /admin (the page) and /admin/api/* — false for any other path. */
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method not allowed' }); return true; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" });
        res.end(req.method === 'HEAD' ? undefined : PAGE);
        return true;
      }
      if (url.pathname === '/admin/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(SCRIPT);
        return true;
      }
      if (!url.pathname.startsWith('/admin/api/')) { json(res, 404, { error: 'Not found' }); return true; }
      try { await api(req, res, url); }
      catch (error) { json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : 'admin request failed' }); }
      return true;
    },
  };
}

const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NadoVibe 관리자</title>
<style>
  :root { color-scheme: light dark; --line: #d4d4d8; --muted: #71717a; --accent: #2563eb; --danger: #dc2626; }
  @media (prefers-color-scheme: dark) { :root { --line: #3f3f46; --muted: #a1a1aa; } }
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; max-width: 920px; margin-inline: auto; }
  h1 { font-size: 20px; margin: 0 0 16px; display: flex; align-items: center; gap: 12px; }
  h1 button { margin-left: auto; }
  input, select, button { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
  button { cursor: pointer; } button.primary { background: var(--accent); border-color: var(--accent); color: #fff; } button.danger { color: var(--danger); }
  button:disabled { opacity: .5; cursor: default; }
  form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; } td.actions { white-space: nowrap; } td.actions button { padding: 4px 8px; font-size: 12px; margin-right: 4px; }
  .note { color: var(--muted); font-size: 12px; } .error { color: var(--danger); min-height: 20px; } .tag { font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-left: 6px; color: var(--muted); }
  #login { max-width: 320px; margin: 15vh auto 0; } #login form { flex-direction: column; align-items: stretch; }
</style></head>
<body>
<div id="login" hidden>
  <h1>NadoVibe 관리자</h1>
  <form id="login-form"><input name="username" placeholder="관리자 아이디" autocomplete="username" autocapitalize="none" required><input name="password" type="password" placeholder="비밀번호" autocomplete="current-password" required><button class="primary">로그인</button></form>
  <div class="error" id="login-error"></div>
</div>
<div id="main" hidden>
  <h1>사용자 관리 <button id="logout" type="button">로그아웃</button></h1>
  <form id="add-form"><input name="username" placeholder="새 아이디 (영문 소문자·숫자)" autocomplete="off" autocapitalize="none" required><select name="role"><option value="user">일반</option><option value="admin">관리자</option></select><button class="primary" id="add-button">사용자 추가</button><span class="note" id="initial-note"></span></form>
  <div class="error" id="error"></div>
  <table><thead><tr><th>아이디</th><th>상태</th><th>권한</th><th></th></tr></thead><tbody id="users"></tbody></table>
</div>
<script src="/admin/app.js"></script>
</body></html>`;

const SCRIPT = `(() => {
  const $ = (id) => document.getElementById(id);
  const call = async (method, path, body) => {
    const r = await fetch('/admin/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/login') { show(false); throw new Error(data.error || '관리자 로그인이 필요합니다'); }
    if (!r.ok) throw new Error(data.error || ('요청 실패 (' + r.status + ')'));
    return data;
  };
  const show = (signedIn) => { $('login').hidden = signedIn; $('main').hidden = !signedIn; };
  const setError = (e) => { $('error').textContent = e ? (e.message || String(e)) : ''; };
  const button = (label, onClick, cls) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.onclick = async () => { b.disabled = true; setError(null); try { await onClick(); } catch (e) { setError(e); } finally { b.disabled = false; } }; return b; };
  let initial = '123456';
  const render = (users) => {
    const body = $('users'); body.replaceChildren();
    for (const u of users) {
      const tr = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = u.username;
      const state = document.createElement('td'); state.textContent = u.active ? '활성' : '비활성';
      if (u.mustChangePassword) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = '첫 로그인 때 비밀번호 변경'; state.append(t); }
      const role = document.createElement('td'); role.textContent = u.role === 'admin' ? '관리자' : '일반';
      const actions = document.createElement('td'); actions.className = 'actions';
      actions.append(
        button('이름 변경', async () => { const next = prompt('새 아이디', u.username); if (next && next !== u.username) render((await call('PATCH', '/users/' + u.id, { username: next })).users); }),
        button(u.role === 'admin' ? '일반으로' : '관리자로', async () => render((await call('PATCH', '/users/' + u.id, { role: u.role === 'admin' ? 'user' : 'admin' })).users)),
        button(u.active ? '비활성화' : '활성화', async () => render((await call('PATCH', '/users/' + u.id, { active: !u.active })).users)),
        button('비밀번호 초기화', async () => { if (confirm(u.username + '의 비밀번호를 ' + initial + '(으)로 초기화할까요? 열려 있는 로그인은 모두 끊기고, 다음 로그인 때 새 비밀번호를 정합니다.')) render((await call('POST', '/users/' + u.id + '/reset-password')).users); }),
        button('삭제', async () => { if (confirm(u.username + ' 계정과 실행 환경(컨테이너)을 삭제할까요? 되돌릴 수 없습니다.')) render((await call('DELETE', '/users/' + u.id)).users); }, 'danger'),
      );
      tr.append(name, state, role, actions); body.append(tr);
    }
  };
  const load = async () => { const data = await call('GET', '/users'); initial = data.initialPassword; $('initial-note').textContent = '초기 비밀번호 ' + initial + ' — 첫 로그인 때 새 비밀번호로 바꿉니다'; show(true); render(data.users); };
  $('login-form').onsubmit = async (event) => {
    event.preventDefault(); $('login-error').textContent = '';
    const f = new FormData(event.target);
    try { await call('POST', '/login', { username: f.get('username'), password: f.get('password') }); event.target.reset(); await load(); }
    catch (e) { $('login-error').textContent = e.message; }
  };
  $('add-form').onsubmit = async (event) => {
    event.preventDefault(); setError(null);
    const f = new FormData(event.target); const add = $('add-button');
    add.disabled = true; add.textContent = '만드는 중… (최대 2분)';
    try { render((await call('POST', '/users', { username: f.get('username'), role: f.get('role') })).users); event.target.reset(); }
    catch (e) { setError(e); } finally { add.disabled = false; add.textContent = '사용자 추가'; }
  };
  $('logout').onclick = async () => { await call('POST', '/logout').catch(() => {}); show(false); };
  load().catch(() => show(false));
})();`;
