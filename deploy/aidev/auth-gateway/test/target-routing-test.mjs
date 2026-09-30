// F-08: remote_action fusion (Laya + lexical prior), target rules (explicit → named → chat pin →
// account default → only PC → Laya target.select, logged) and device.select for attached devices.
//   node test/target-routing-test.mjs   (after npm run build)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-target-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route, remotePrior, remoteDecision, mentionedTarget, mentionsDevice, targetDevices } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const engines = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };

/**
 * Laya stand-in: remote_action has no opinion (uniform, so the lexical prior decides); a caller-choice
 * question (target.select / device.select) picks its LAST option confidently, so a Laya pick is
 * distinguishable from the first-option fallback. `calls` records the question sets it was asked.
 */
const calls = [];
const laya = {
  status: {},
  predict: async (state, questions) => {
    calls.push(Object.keys(questions));
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'agent') answers[id] = { choice: 'backend-node', probabilities: { 'backend-node': 0.9 }, confidence: 0.9 };
      else if (id === 'remote_action') { const keys = Object.keys(q.criteria); answers[id] = { probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) }; }
      else if (id === 'q') { const keys = Object.keys(q.criteria); const k = keys[keys.length - 1]; answers[id] = { choice: k, probabilities: Object.fromEntries(keys.map((x) => [x, x === k ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])), confidence: 0.9 }; }
      else if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; }
      else answers[id] = { score: 1 };
    }
    return { answers, latency_ms: 1, device: 'mock' };
  },
};
const go = (text, extra = {}) => route(store, laya, uid, engines, { text, ...extra });

// ---- lexical prior + fusion -------------------------------------------------------------------
const p = remotePrior('내 맥에서 테스트 돌려서 결과 알려줘');
assert.ok(Object.keys(p).length === 6, 'prior over all six actions');
assert.equal(Object.entries(p).sort((a, b) => b[1] - a[1])[0][0], 'test');
assert.equal(remoteDecision(null, remotePrior('이 함수 이름을 더 명확하게 바꿔줘')).action, 'none');
assert.equal(remoteDecision({ none: 0.2, run: 0.2, test: 0.2, debug: 0.2, build: 0.1, screenshot: 0.1 }, { screenshot: 0.4, none: 0.3, run: 0.3 }, 0.35, 0.9).action, 'none', 'under min_p → none');
console.log('PASS remote_action lexical prior (test / none) and the min_p rule');

// ---- helpers ------------------------------------------------------------------------------------
const T = (name) => ({ name });
assert.equal(mentionedTarget('m4pro에서 서버 재시작해줘', [T('m4pro'), T('win-box')])?.name, 'm4pro');
assert.equal(mentionedTarget('m4pro2에서 실행', [T('m4pro')]), null, 'a longer word is not the name');
assert.equal(mentionedTarget('jazzlife mac에서 빌드해줘', [T('jazzlife-mac')])?.name, 'jazzlife-mac', 'dash may be a space');
assert.equal(mentionedTarget('on mac-mini-2 please', [T('mac-mini'), T('mac-mini-2')])?.name, 'mac-mini-2', 'longest name wins');
assert.ok(mentionsDevice('갤럭시 기기에서 앱 실행해줘') && mentionsDevice('Install the apk on the phone') && !mentionsDevice('폰트 크기 키워줘'));
assert.deepEqual(targetDevices({ devices: { adb: ['A1'], sdb: ['T9'] } }), [{ serial: 'A1', tool: 'adb' }, { serial: 'T9', tool: 'sdb' }]);
console.log('PASS target mention, device words, device list');

// ---- targets --------------------------------------------------------------------------------------
const add = (name, lastSeen, caps = {}) => {
  const id = store.addTarget({ userId: uid, name, platform: 'darwin', pairingCode: name.toUpperCase(), pairingExpires: Date.now() + 60000 });
  store.updateTarget(uid, id, { status: 'online', lastSeen, capabilities: caps });
  return id;
};
let r = await go('내 맥에서 테스트 돌려줘');
assert.equal(r.plan.target, null, 'no PC online → no remote_action question at all');
assert.ok(!calls.at(-1).includes('remote_action'));

const mac = add('mac-mini', 2000, { tools: { node: '22', xcodebuild: '16' } });
r = await go('내 맥에서 테스트 돌려줘');
assert.equal(r.scope.remote_action, 'test'); assert.equal(r.plan.target.name, 'mac-mini'); assert.equal(r.plan.target.source, 'single');
r = await go('이 함수 이름을 더 명확하게 바꿔줘');
assert.equal(r.scope.remote_action, 'none'); assert.equal(r.plan.target, null);
console.log('PASS one PC: a PC command goes to it (single); code work stays in the cloud (none)');

const win = add('win-box', 1000, { tools: { node: '22', msbuild: '17' }, devices: { adb: ['R3CN11', 'EMU5554'] } });
r = await go('내 PC에서 서버 띄워줘');
assert.equal(r.plan.target.source, 'laya'); assert.ok(r.target_decision.decision_id > 0);
// options are most-recently-seen first; the stand-in picks the last one → win-box
assert.equal(r.plan.target.name, 'win-box');
const logged = store.db.prepare('SELECT kind, answer, state FROM decision_log WHERE id=?').get(r.target_decision.decision_id);
assert.equal(logged.kind, 'target.select'); assert.equal(JSON.parse(logged.answer), 'win-box');
assert.match(logged.state, /msbuild/, 'Laya sees the tools of each PC');
assert.deepEqual(r.targets.map((t) => t.name).sort(), ['mac-mini', 'win-box']);
console.log('PASS two PCs: Laya target.select (logged as its own decision, tools in the options)');

r = await go('win-box에서 이 코드 봐줘');
assert.equal(r.plan.target.name, 'win-box'); assert.equal(r.plan.target.source, 'mention'); assert.notEqual(r.scope.remote_action, 'none');
console.log(`PASS a PC named in the command wins and forces a remote action (${r.scope.remote_action})`);

store.setDefaultTarget(uid, mac, true);
r = await go('내 PC에서 서버 띄워줘');
assert.equal(r.plan.target.name, 'mac-mini'); assert.equal(r.plan.target.source, 'default'); assert.equal(r.target_decision, null);
store.setDefaultTarget(uid, win, true);
assert.equal(store.targets(uid).filter((t) => t.is_default).map((t) => t.name).join(), 'win-box', 'one default per account');
store.setDefaultTarget(uid, mac, true);
console.log('PASS account default PC');

store.setSessionTarget(uid, 's-1', win);
r = await go('내 PC에서 서버 띄워줘', { sessionId: 's-1' });
assert.equal(r.plan.target.name, 'win-box'); assert.equal(r.plan.target.source, 'session');
r = await go('내 PC에서 서버 띄워줘', { sessionId: 's-1', targetId: mac });
assert.equal(r.plan.target.name, 'mac-mini'); assert.equal(r.plan.target.source, 'input');
store.setSessionEffortCap(uid, 's-1', null);
assert.equal(store.sessionTarget(uid, 's-1'), win, 'clearing the effort cap keeps the PC pin');
store.updateTarget(uid, win, { status: 'offline' });
r = await go('내 PC에서 서버 띄워줘', { sessionId: 's-1' });
assert.equal(r.plan.target.name, 'mac-mini'); assert.match(r.plan.reason.join('\n'), /pinned PC is offline/);
store.updateTarget(uid, win, { status: 'online' });
store.setSessionTarget(uid, 's-1', null);
assert.equal(store.sessionTarget(uid, 's-1'), null);
assert.throws(() => store.setSessionTarget(uid, 's-1', 9999), /not found/);
console.log('PASS chat pin beats the default, the chip pick beats both, an offline pin falls through');

// ---- devices ------------------------------------------------------------------------------------------
r = await go('win-box 갤럭시 기기에서 앱 실행해줘');
assert.equal(r.plan.device.source, 'laya'); assert.equal(r.plan.device.serial, 'EMU5554'); assert.ok(r.device_decision.decision_id > 0);
r = await go('win-box의 R3CN11 기기에 앱 설치해서 실행해줘');
assert.deepEqual([r.plan.device.serial, r.plan.device.source], ['R3CN11', 'mention']);
r = await go('win-box에서 서버 띄워줘');
assert.equal(r.plan.device, null, 'not about a device → no device pick');
store.updateTarget(uid, win, { capabilities: { devices: { sdb: ['TV01'] } } });
r = await go('win-box에서 TV에 앱 올려서 실행해줘');
assert.deepEqual([r.plan.device.serial, r.plan.device.tool, r.plan.device.source], ['TV01', 'sdb', 'single']);
console.log('PASS device.select: serial named / only device / Laya among several; none when not about a device');

// ---- Laya down: lexical prior alone -----------------------------------------------------------------
r = await route(store, { status: {}, predict: async () => { throw new Error('offline'); } }, uid, engines, { text: '내 맥에서 빌드해줘' });
assert.equal(r.scope.remote_action, 'build'); assert.equal(r.plan.target.name, 'mac-mini');
console.log('PASS Laya down: remote_action from the lexical prior, default PC');

fs.rmSync(dir, { recursive: true, force: true });
console.log('target routing: all checks passed');
