import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

/**
 * nadovibe_show / nadovibe_settings against a fake gateway: the PC name resolves to its id, the whole screen is the
 * default window, nobody watching is reported, and each setting goes to its gateway call (changed directly).
 */
const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
let viewers = 1;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    const path = (req.url ?? '').replace(/^\/internal\/aidev/, '');
    calls.push({ method: req.method ?? 'GET', path, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    const reply = path === '/targets' ? { targets: [{ id: 4, name: 'm4pro', online: true, platform: 'macos', policy: 'full', capabilities: { screen: true, control: false } }] }
      : path === '/engines' ? { engines: { claude: {} }, effort_cap: { claude: 'high' }, effort_ladder: { claude: ['low', 'high', 'xhigh'] } }
      : path === '/ui/commands' ? { viewers, command: { id: 1 } }
      : path === '/targets/4/consent' ? { consent: { screen: true, control: Boolean(body.control) } }
      : {};
    res.end(JSON.stringify(reply));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.AIDEV_RUNTIME = 'rt-test';
process.env.AIDEV_GATEWAY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.JWT_SECRET = 'x'.repeat(48);
const { appShow, appSettingsGet, appSettingsSet } = await import('@/modules/aidev-tools/app-control.service.js');
test.after(() => server.close());

test('show: the PC by name, the whole screen by default, the note passed on', async () => {
  calls.length = 0;
  const r = await appShow({ view: 'screen', target: 'm4pro', note: '로그인 창을 확인해 주세요' }, { agent: 'dotnet-wpf' });
  assert.equal(r.shown, true);
  const sent = calls.find((c) => c.path === '/ui/commands')!;
  assert.deepEqual(sent.body.params, { target: 4, window: 'full' });
  assert.equal(sent.body.note, '로그인 창을 확인해 주세요');
  assert.equal(sent.body.agent, 'dotnet-wpf');
});

test('show with nobody watching says so', async () => {
  viewers = 0;
  const r = await appShow({ view: 'pcs' });
  assert.equal(r.shown, false);
  assert.match(r.message, /보고 있는 화면이 없습니다/);
  viewers = 1;
  await assert.rejects(appShow({ view: 'terminal' }), /view/);
});

test('settings: read, then each key goes to its gateway call', async () => {
  const s = await appSettingsGet();
  assert.equal(s.pcs[0].name, 'm4pro');
  assert.equal(s.pcs[0].control, false);
  calls.length = 0;
  assert.equal((await appSettingsSet({ key: 'pc.control', value: 'true', target: 'm4pro' })).value, true);
  assert.deepEqual(calls.find((c) => c.path === '/targets/4/consent')?.body, { control: true });
  await appSettingsSet({ key: 'pc.policy', value: 'ask', target: 'm4pro' });
  assert.deepEqual(calls.find((c) => c.method === 'PATCH')?.body, { policy: 'ask' });
  await appSettingsSet({ key: 'effort_cap.claude', value: 'xhigh' });
  assert.deepEqual(calls.find((c) => c.method === 'PUT')?.body, { claude: 'xhigh' });
  const mode = await appSettingsSet({ key: 'routing_mode', value: 'manual' });
  assert.equal(mode.applied_on_pages, 1);
  await assert.rejects(appSettingsSet({ key: 'pc.policy', value: 'yolo', target: 'm4pro' }), /full \| auto/);
  await assert.rejects(appSettingsSet({ key: 'nope', value: 1 }), /알 수 없는 설정/);
});
