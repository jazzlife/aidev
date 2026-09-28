// E-02 lesson loop against a scratch DB: trial → verified → promoted (merged or pinned), trial
// rejection, demotion, and what route-time selection would carry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-lessons-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { applyLessonOutcome, PROMOTE_HITS } = await import('../dist/lesson-loop.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const globalAgent = store.agent(uid, 'frontend-react');
let decision = 1000;
const run = (lessonIds, trialId, outcome) => { decision++; store.recordInjectedLessons(decision, lessonIds.map((id) => ({ id, trial: id === trialId }))); return applyLessonOutcome(store, decision, outcome); };

// 1) private lesson on a global agent: trial success → verified(auto) → 3 successes → pinned
const a = store.addLesson({ agentId: globalAgent.id, trigger: '배지 같은 UI 요소를 추가할 때', rule: '기본 스타일까지 포함해 완성된 모양으로 전달한다', ownerId: uid, status: 'candidate' });
console.log(run([a], a, 'success').join('; '));
let l = store.lessonById(a); assert.equal(l.status, 'verified'); assert.equal(l.verified_by, 'auto'); assert.equal(l.hits, 1);
run([a], null, 'success'); const log3 = run([a], null, 'success');
l = store.lessonById(a); assert.equal(l.hits, PROMOTE_HITS); assert.equal(l.promoted_to_prompt, 1); assert.equal(l.promoted_version, null);
assert.match(log3.join(), /pinned for frontend-react/);
assert.equal(store.agentById(globalAgent.id).version, globalAgent.version, 'a global agent is not rewritten by a private lesson');
console.log('PASS trial → verified(auto) → pinned after', PROMOTE_HITS, 'successes (global agent untouched)');

// 2) private agent + private lesson: promotion merges the rule into a new prompt version
const own = store.addAgent({ name: 'unity-shader', domain: 'graphics', description: 'Unity shader graph and HLSL specialist for URP/HDRP pipelines', prompt: 'You are a Unity shader specialist. Verify in the editor.', ownerId: uid, source: 'generated' });
const ownAgent = store.agentById(typeof own === 'number' ? own : own.id);
const b = store.addLesson({ agentId: ownAgent.id, trigger: 'URP에서 투명 셰이더를 만들 때', rule: 'Render Queue를 Transparent로 두고 ZWrite를 끈다', ownerId: uid, status: 'candidate' });
run([b], b, 'success'); run([b], null, 'success'); const merged = run([b], null, 'success');
const after = store.agentById(ownAgent.id);
assert.equal(after.version, ownAgent.version + 1); assert.match(after.prompt, /검증된 규칙[\s\S]*Render Queue를 Transparent/);
assert.equal(store.lessonById(b).promoted_version, after.version);
assert.match(store.agentVersions(ownAgent.id)[0].changelog, /교훈 #\d+ 승격/);
console.log('PASS merged into', ownAgent.name, `v${after.version}:`, merged.join());

// 3) a trial candidate that fails twice is rejected; a single unrelated failure is tolerated
const c = store.addLesson({ agentId: globalAgent.id, trigger: '모든 경우에 테스트를 먼저 작성할 때', rule: '구현 전에 스냅샷 테스트를 만든다', ownerId: uid, status: 'candidate' });
run([c], c, 'fail'); assert.equal(store.lessonById(c).status, 'candidate');
run([c], c, 'fail'); assert.equal(store.lessonById(c).status, 'rejected');
console.log('PASS trial rejected after 2 failures');

// 4) a verified rule that fails more than it helps goes back to candidate
const d = store.addLesson({ agentId: globalAgent.id, trigger: '상태 관리를 추가할 때', rule: '항상 전역 스토어를 만든다', ownerId: uid, status: 'verified' });
run([d], null, 'success'); run([d], null, 'fail'); run([d], null, 'fail'); run([d], null, 'fail');
assert.equal(store.lessonById(d).status, 'candidate');
console.log('PASS verified → candidate after failing more than helping');

// 5) no double counting when nothing was carried
assert.deepEqual(run([], null, 'success'), []);
store.db.close();
console.log('ALL PASS');
