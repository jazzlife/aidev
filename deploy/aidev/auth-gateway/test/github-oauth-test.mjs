// "GitHub로 로그인": the state ties GitHub's return to the user, the code becomes a token stored in their runtime
// (replacing that account's earlier one), and only same-origin app paths are returned to.
//   npm run build && node test/github-oauth-test.mjs
import assert from 'node:assert/strict';

const { createGithubOauth, safeReturn, GithubOauthError } = await import('../dist/github-oauth.js');
const kv = new Map();
const runtimeCalls = [];
let credentials = [{ id: 3, credential_name: 'GitHub @jazzlife' }];
const oauth = createGithubOauth({
  store: { kvGet: (k) => kv.get(k) ?? null, kvSet: (k, v) => kv.set(k, v) },
  publicOrigin: 'https://dev.nado.work',
  runtimeOf: (id) => (id === 3 ? 'u70edd047aee13516505c5c78' : null),
  runtimeFetch: async (runtime, path, init = {}) => {
    runtimeCalls.push({ runtime, path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (path.startsWith('/api/settings/credentials?')) return new Response(JSON.stringify({ credentials }));
    return new Response('{}', { status: 200 });
  },
  fetch: async (url, init = {}) => {
    if (String(url).includes('access_token')) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify(body.code === 'good' ? { access_token: 'gho_abc' } : { error_description: 'bad code' }));
    }
    return new Response(JSON.stringify({ login: 'jazzlife' }));
  },
});

assert.equal(oauth.publicConfig(false).configured, false);
assert.throws(() => oauth.start(3, null), (e) => e instanceof GithubOauthError && e.status === 409);
assert.throws(() => oauth.setConfig({ clientId: 'x', clientSecret: 'y' }), /Client ID/);
oauth.setConfig({ clientId: 'Ov23liAbCdEf12345678', clientSecret: 'a'.repeat(40) });
assert.deepEqual(oauth.publicConfig(false), { configured: true, callbackUrl: 'https://dev.nado.work/_gateway/github/callback', homepageUrl: 'https://dev.nado.work', admin: false });
assert.equal(oauth.publicConfig(true).clientId, 'Ov23liAbCdEf12345678');
// an empty secret keeps the saved one
oauth.setConfig({ clientId: 'Ov23liAbCdEf12345678', clientSecret: '' });
assert.equal(JSON.parse(kv.get('github.oauth')).clientSecret, 'a'.repeat(40));

const url = new URL(oauth.start(3, '/m/projects?add=clone'));
assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
assert.equal(url.searchParams.get('redirect_uri'), 'https://dev.nado.work/_gateway/github/callback');
assert.equal(url.searchParams.get('scope'), 'repo read:user');
const state = url.searchParams.get('state');

const done = await oauth.callback('good', state, null);
assert.equal(done, '/m/projects?add=clone&github=connected&account=jazzlife');
assert.deepEqual(runtimeCalls.map((c) => `${c.method} ${c.path}`), ['GET /api/settings/credentials?type=github_token', 'DELETE /api/settings/credentials/3', 'POST /api/settings/credentials']);
assert.deepEqual(runtimeCalls[2].body, { credentialName: 'GitHub @jazzlife', credentialType: 'github_token', credentialValue: 'gho_abc', description: 'GitHub 로그인(OAuth)' });
// the state is single use
assert.match(await oauth.callback('good', state, null), /github=error/);

const s2 = new URL(oauth.start(3, null)).searchParams.get('state');
assert.match(await oauth.callback(null, s2, 'access_denied'), /^\/m\/projects\?github=error&reason=/);
const s3 = new URL(oauth.start(3, null)).searchParams.get('state');
assert.equal(new URLSearchParams((await oauth.callback('bad', s3, null)).split('?')[1]).get('reason'), 'bad code');

assert.equal(safeReturn('https://evil.example/x'), '/m/projects');
assert.equal(safeReturn('//evil.example'), '/m/projects');
assert.equal(safeReturn('/m/settings'), '/m/settings');
console.log('github-oauth-test: ok');
