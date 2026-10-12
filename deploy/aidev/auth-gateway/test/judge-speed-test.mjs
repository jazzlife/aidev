// A specialist is chosen fast without guessing (2026-10-13): the verdict on the draft the user paused on stands for
// the command they send when it is the same command, a judge call already running for it is joined, a chat's
// follow-ups ask the judge for no clarifying question, and a judge that is slow leaves the work to the generalist
// (never a probability pick) while its late verdict is kept for the next send.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-judge-speed-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route, prejudge, sameCommand } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const engines = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };
const laya = { status: {}, predict: async (_s, questions) => ({ answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === 'score' ? { score: 1 } : q.type === 'noul' ? { noul: 0.1 } : { choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 0.9 } }])), latency_ms: 1 }) };
const calls = [];
const judge = (agent, ms = 0) => async (input) => { calls.push(input); await new Promise((r) => setTimeout(r, ms)); return { agent, fit: 0.9, reason: 'r', new: null, question: null, current_fit: null, level: 2 }; };
const settle = () => new Promise((r) => setTimeout(r, 20));

// sameCommand: spacing, punctuation and up to two trailing characters; not a different command
assert.ok(sameCommand('React 컴포넌트에 다크모드 토글 훅을 추가해', 'React 컴포넌트에 다크모드 토글 훅을 추가해줘.'));
assert.ok(sameCommand('nginx  설정 고쳐줘!', 'nginx 설정 고쳐줘'));
assert.ok(!sameCommand('React 컴포넌트에 다크모드 토글 훅을 추가해', 'React 컴포넌트에 다크모드 토글 훅을 추가해서 테스트도 돌려줘'));
assert.ok(!sameCommand('삭제해', '삭제해줘'), 'too short to tell');

// the draft's verdict stands for the sent command: one judge call
prejudge(store, uid, { text: 'React 컴포넌트에 다크모드 토글 훅을 추가해' }, judge('frontend-react'));
await settle();
let r = await route(store, laya, uid, engines, { text: 'React 컴포넌트에 다크모드 토글 훅을 추가해줘.' }, { judge: judge('database') });
assert.equal(calls.length, 1, 'the send did not ask again'); assert.equal(r.agent.name, 'frontend-react'); assert.equal(r.judge.source, 'cache');
// a different command is judged afresh
r = await route(store, laya, uid, engines, { text: '주문 테이블 인덱스를 설계해줘' }, { judge: judge('database') });
assert.equal(calls.length, 2); assert.equal(r.agent.name, 'database');
// a judge call still running for the draft is joined, not repeated
prejudge(store, uid, { text: 'nginx 리버스 프록시에 웹소켓 업그레이드 설정을 넣어' }, judge('devops', 80));
r = await route(store, laya, uid, engines, { text: 'nginx 리버스 프록시에 웹소켓 업그레이드 설정을 넣어줘' }, { judge: judge('database') });
assert.equal(calls.length, 3); assert.equal(r.agent.name, 'devops'); assert.equal(r.judge.prejudged, true);
console.log('PASS the draft\'s verdict (cached or running) stands for the same command sent; another command is judged');

// a new chat asks for the clarifying question; a chat's follow-up does not
assert.equal(calls.at(-1).ask, true);
store.addRun({ userId: uid, sessionId: 'sess-1', agentId: store.agent(uid, 'devops').id, engine: 'claude', model: 'opus', effort: 'high', depth: 2 });
await route(store, laya, uid, engines, { text: 'TLS 인증서 갱신도 붙여줘', sessionId: 'sess-1' }, { judge: judge('devops') });
assert.equal(calls.at(-1).ask, false);
console.log('PASS a follow-up in a chat asks the judge for no clarifying question');

// a slow judge: the generalist starts the work; the late verdict is cached for the next send
r = await route(store, laya, uid, engines, { text: 'Playwright e2e 테스트가 CI에서만 실패하는 원인 고쳐줘' }, { judge: judge('testing', 120), judgeWaitMs: 30 });
assert.equal(r.agent.name, 'generalist', r.plan.reason.join(' | '));
assert.ok(r.plan.reason.some((line) => line.startsWith('no specialist judge verdict → generalist')));
await new Promise((res) => setTimeout(res, 150));
const before = calls.length;
r = await route(store, laya, uid, engines, { text: 'Playwright e2e 테스트가 CI에서만 실패하는 원인 고쳐줘' }, { judge: judge('database') });
assert.equal(calls.length, before, 'the late verdict was kept'); assert.equal(r.agent.name, 'testing');
console.log('PASS a slow judge leaves this send to the generalist, never a guess; its verdict serves the next one');

fs.rmSync(dir, { recursive: true, force: true });
console.log('judge speed: all checks passed');
