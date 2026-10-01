// Clarify (§3.1, C-05): at depth ≥ 2 the specialist judge decides and words the question; without a judge verdict
// Laya's clarify (> 0.7) decides. A cached verdict keeps its question.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-clarify-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const engines = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };

/** Laya stand-in: frontend-react at the given depth, with the given clarify probability. */
const laya = ({ depth, clarify }) => ({
  status: {},
  predict: async (_state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'agent') answers[id] = { choice: 'frontend-react', probabilities: { 'frontend-react': 0.97 }, confidence: 0.97 };
      else if (id === 'depth') answers[id] = { score: depth };
      else if (id === 'risk') answers[id] = { score: 0 };
      else if (id === 'task_kind') answers[id] = { choice: 'implement', probabilities: { implement: 0.95 }, confidence: 0.95 };
      else if (id === 'clarify') answers[id] = { noul: clarify };
      else if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; }
      else answers[id] = { score: 0 };
    }
    return { answers, latency_ms: 1, device: 'mock' };
  },
});
const judge = (question) => async () => ({ agent: 'frontend-react', fit: 0.9, reason: 'react', new: null, question });
const go = (l, text, j) => route(store, l, uid, engines, { text }, { judge: j });

let r = await go(laya({ depth: 2.5, clarify: 0.1 }), '로그인 버튼 고쳐줘', judge('어느 화면의 로그인 버튼인가요?'));
assert.equal(r.scope.ask_clarify, true); assert.equal(r.scope.clarify_question, '어느 화면의 로그인 버튼인가요?');
console.log('PASS the judge has a question → ask with it (Laya\'s low clarify does not veto)');

r = await go(laya({ depth: 2.5, clarify: 0.9 }), 'web/Login.tsx의 버튼 색 바꿔줘', judge(null));
assert.equal(r.scope.ask_clarify, false); assert.equal(r.scope.clarify_question, null);
r = await go(laya({ depth: 0.5, clarify: 0.9 }), '버튼 색 바꿔줘', judge('어떤 버튼인가요?'));
assert.equal(r.scope.ask_clarify, false); assert.equal(r.scope.clarify_question, null);
console.log('PASS no ask when the judge has no question (whatever Laya says), or for a shallow command');

r = await go(laya({ depth: 2.5, clarify: 0.9 }), '대시보드 만들어줘', undefined);
assert.equal(r.scope.ask_clarify, true); assert.equal(r.scope.clarify_question, null);
r = await go(laya({ depth: 2.5, clarify: 0.3 }), '차트 만들어줘', undefined);
assert.equal(r.scope.ask_clarify, false);
console.log('PASS without the judge Laya decides (clarify > 0.7); no question → the app\'s generic ask');

r = await go(laya({ depth: 2.5, clarify: 0.1 }), '로그인 버튼 고쳐줘', async () => { throw new Error('judge must not run'); });
assert.equal(r.judge.source, 'cache'); assert.equal(r.scope.ask_clarify, true); assert.equal(r.scope.clarify_question, '어느 화면의 로그인 버튼인가요?');
console.log('PASS a cached verdict keeps its question');

// Laya scores "그 버그 고쳐줘" D1, the debug floor raises it to D2: the floored depth decides (server, 42e969da)
const debugLaya = { status: {}, predict: async (state, questions) => { const out = await laya({ depth: 1.1, clarify: 0.4 }).predict(state, questions); out.answers.task_kind = { choice: 'debug', probabilities: { debug: 0.92 }, confidence: 0.92 }; return out; } };
r = await go(debugLaya, '저 에러 고쳐줘', judge('어떤 에러인가요?'));
assert.equal(r.scope.depth, 2); assert.equal(r.scope.ask_clarify, true); assert.equal(r.scope.clarify_question, '어떤 에러인가요?');
console.log('PASS a debug command floored to D2 asks even when Laya scored it D1');

// an unclear command: the judge finds no specialist and nothing to create, only a question → no agent creation
r = await go(laya({ depth: 2.5, clarify: 0.9 }), '그 버그 고쳐줘', async () => ({ agent: null, fit: 0, reason: 'unclear', new: null, question: '어느 버그인가요?' }));
assert.equal(r.decision, 'generalist'); assert.equal(r.create, null); assert.equal(r.scope.clarify_question, '어느 버그인가요?');
r = await go(laya({ depth: 2.5, clarify: 0.2 }), 'Verilog UART 모듈', async () => ({ agent: null, fit: 0, reason: 'no hdl agent', new: { name: 'verilog-hdl', domain: 'hdl', description: 'Verilog', technologies: ['Verilog'] }, question: null }));
assert.equal(r.decision, 'create');
console.log('PASS unclear command (no specialist, nothing to propose, a question) → generalist, not creation; a real new domain still creates');

// an unclear command is not sent to a PC on Laya's remote guess; naming the PC keeps it remote
const pc = store.addTarget({ userId: uid, name: 'm4pro', platform: 'darwin', pairingCode: 'M4PRO', pairingExpires: Date.now() + 60000 });
store.updateTarget(uid, pc, { status: 'online', lastSeen: Date.now(), capabilities: {} });
const remoteLaya = { status: {}, predict: async (state, questions) => { const out = await laya({ depth: 2.5, clarify: 0.4 }).predict(state, questions); if (questions.remote_action) out.answers.remote_action = { choice: 'test', probabilities: { test: 0.95, none: 0.05 } }; return out; } };
r = await go(remoteLaya, '그 에러 좀 봐줘', judge('어떤 에러인가요?'));
assert.equal(r.scope.ask_clarify, true); assert.equal(r.scope.remote_action, 'none'); assert.equal(r.plan.target, null);
r = await go(remoteLaya, 'm4pro에서 그 에러 좀 봐줘', judge('어떤 에러인가요?'));
assert.notEqual(r.scope.remote_action, 'none'); assert.equal(r.plan.target?.name, 'm4pro');
r = await go(remoteLaya, 'npm test 돌려서 결과 알려줘', judge(null));
assert.equal(r.scope.remote_action, 'test');
console.log('PASS an unclear command gets no remote action (unless a PC is named); a clear one keeps Laya\'s');

// agents.uses counts runs, not routing picks
const react = store.agent(uid, 'frontend-react');
const before = store.agentById(react.id).uses;
await go(laya({ depth: 1, clarify: 0.1 }), 'React 훅 추가', judge(null));
assert.equal(store.agentById(react.id).uses, before, 'a route alone is not a use');
store.addRun({ userId: uid, agentId: react.id });
assert.equal(store.agentById(react.id).uses, before + 1, 'a run is');
console.log('PASS agents.uses counts runs, not routing picks');

fs.rmSync(dir, { recursive: true, force: true });
console.log('clarify question: all checks passed');
