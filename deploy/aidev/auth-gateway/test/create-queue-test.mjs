// D-04 (§3.7): no specialist + quick work (D0–1) → generalist now and the domain is queued; the same domain three
// times → proposed once; accepting a proposal routes the next turn to the architect with that domain.
//   node test/create-queue-test.mjs   (after npm run build)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-cq-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route, CREATE_PROPOSE_AT } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const engines = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };

const laya = (depth) => ({
  status: {},
  predict: async (_state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'agent') answers[id] = { choice: 'testing', probabilities: { testing: 0.6 }, confidence: 0.6 };
      else if (id === 'depth') answers[id] = { score: depth };
      else if (id === 'risk') answers[id] = { score: 0 };
      else if (id === 'task_kind') answers[id] = { choice: 'implement', probabilities: { implement: 0.95 }, confidence: 0.95 };
      else if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; }
      else answers[id] = { score: 0 };
    }
    return { answers, latency_ms: 1, device: 'mock' };
  },
});
const newDomain = (name, domain, technologies) => async () => ({ agent: null, fit: 0, reason: 'no specialist', new: { name, domain, description: `${domain} work`, technologies }, question: null });
const unity = (name) => newDomain(name, 'Unity graphics', ['Unity', 'HLSL', 'Shader Graph']);
const go = (text, judge, depth = 0.6, extra = {}) => route(store, laya(depth), uid, engines, { text, ...extra }, { judge });

assert.equal(CREATE_PROPOSE_AT, 3);
let r = await go('Unity 셰이더 색 하나 바꿔줘', unity('unity-shader'));
assert.equal(r.decision, 'create_background'); assert.equal(r.agent.name, 'generalist');
assert.deepEqual([r.create.queue.count, r.create.queue.proposed_now], [1, false]);
r = await go('Unity 셰이더 그래프 노드 이름 알려줘', unity('unity-shaders'));
assert.deepEqual([r.create.queue.count, r.create.queue.proposed_now], [2, false], 'a differently named proposal of the same domain counts toward it');
r = await go('셰이더에 림라이트 한 줄 추가', unity('unity-graphics'));
assert.deepEqual([r.create.queue.count, r.create.queue.proposed_now], [3, true]);
const id = r.create.queue.id;
r = await go('Unity 머티리얼 값 바꿔줘', unity('unity-shader'));
assert.deepEqual([r.create.queue.count, r.create.queue.proposed_now], [4, false], 'proposed only once');
console.log('PASS quick work in an unknown domain runs on the generalist; the third command proposes its specialist once');

r = await go('Verilog로 UART 송신 모듈 작성', newDomain('verilog-hdl', 'hardware description', ['Verilog', 'FPGA']), 2.5);
assert.equal(r.decision, 'create'); assert.equal(r.create.queue, null);
const refactorLaya = { status: {}, predict: async (state, questions) => { const out = await laya(1.2).predict(state, questions); out.answers.task_kind = { choice: 'refactor', probabilities: { refactor: 0.9 }, confidence: 0.9 }; return out; } };
r = await route(store, refactorLaya, uid, engines, { text: 'Godot 노드 이름 하나 바꿔줘' }, { judge: newDomain('godot-engine', 'Godot game engine', ['Godot', 'GDScript']) });
assert.equal(r.scope.depth, 2, 'the refactor floor still picks the stronger model'); assert.equal(r.decision, 'create_background');
console.log('PASS deeper work (D2+) still creates the specialist first; a kind floor (refactor ≥ D2) alone does not');

r = await go('Solidity 함수 이름 바꿔줘', newDomain('solidity-contracts', 'smart contracts', ['Solidity', 'EVM']));
assert.notEqual(r.create.queue.id, id, 'another domain is its own entry');
store.setCreateQueueStatus(uid, r.create.queue.id, 'dismissed');
await go('Solidity 이벤트 하나 추가', newDomain('solidity', 'smart contracts', ['Solidity']));
r = await go('Solidity 변수 주석 달아줘', newDomain('solidity-dev', 'smart contracts', ['Solidity', 'EVM']));
assert.deepEqual([r.create.queue.count, r.create.queue.proposed_now], [3, false], 'a dismissed domain keeps counting but is not offered again');
console.log('PASS other domains are separate; a dismissed domain is never offered again');

// 2026-10-10: an ongoing chat never hands its turn to the architect (it answered the user instead of designing)
r = await go('바이너리로 배포하면 소스가 안 보이는 거 맞지?', newDomain('binary-protection', 'code protection', ['Node SEA', 'obfuscation']), 2, { sessionId: 'chat-1' });
assert.equal(r.decision, 'create_background'); assert.equal(r.agent.name, 'generalist'); assert.equal(r.create.background, true);
assert.equal(r.create.design, true, 'the gateway designs the proposed specialist out of band');
assert.equal(r.create.queue, null, 'designed now, not counted toward a proposal');
assert.equal(r.scope.depth, 2, 'no architect floor (D3): the generalist answers at the command\'s own depth');
r = await go('Solidity 컨트랙트 감사 리포트 써줘', newDomain('solidity-audit', 'smart contracts', ['Solidity', 'EVM']), 2.5, { sessionId: 'chat-1' });
assert.equal(r.create.design, false, 'a dismissed domain is not designed on its own'); assert.equal(r.create.queue.count, 4);
r = await go('Verilog로 UART 수신 모듈 작성', newDomain('verilog-hdl', 'hardware description', ['Verilog', 'FPGA']), 2.5);
assert.equal(r.decision, 'create'); assert.equal(r.create.design, false, 'a new chat still starts with the architect');
console.log('PASS an ongoing chat runs on the generalist and its specialist is designed in the background; a new chat keeps the architect turn');

r = await go('[전문 agent 만들기] Unity graphics', async () => { throw new Error('judge not needed'); }, 0.6, { createProposal: id });
assert.equal(r.decision, 'create'); assert.equal(r.create.from_queue, true); assert.equal(r.create.background, false);
assert.equal(r.create.proposal.domain, 'Unity graphics'); assert.equal(r.create.queue.id, id);
assert.equal(store.createQueueEntry(uid, id).commands.length, 4, 'the architect gets the recent commands as context');
console.log('PASS accepting a proposal sends the next turn to the architect with that domain');

fs.rmSync(dir, { recursive: true, force: true });
console.log('create queue: all checks passed');
