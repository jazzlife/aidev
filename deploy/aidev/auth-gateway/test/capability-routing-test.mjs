// What routing is for (user decisions 2026-10-13), checked against the server's own cases rather than the formula:
//  1. the model is the one that carries the work out comfortably — the judge's level against each tier's reliable
//     range — so the strongest models (Fable / Astra) do run, although Laya's depth score never leaves 0.04–2.60;
//  2. a chat whose agent no longer fits the command is handed off to an agent that fits, or a new one is made;
//  3. a command the chat's agent ran only because the chat continued never becomes that agent's routing example.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-capability-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { route, runTeachesAgent, TIER_TABLE } = await import('../dist/routing.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const claudeOnly = { claude: { allowed: true, authenticated: true }, codex: { allowed: false, authenticated: false } };
const codexOnly = { claude: { allowed: false, authenticated: false }, codex: { allowed: true, authenticated: true } };

/** Laya as it answers on the server: a diffuse depth (server #2214: P = .04/.23/.23/.35/.14 → score 2.29). */
const laya = ({ agent = 'generalist', depth = 2.29, kind = 'ops' } = {}) => ({
  status: {},
  predict: async (_state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'agent') answers[id] = { choice: agent, probabilities: { [agent]: 0.6 }, confidence: 0.6 };
      else if (id === 'depth') answers[id] = { score: depth };
      else if (id === 'risk') answers[id] = { score: 0.5 };
      else if (id === 'task_kind') answers[id] = { choice: kind, probabilities: { [kind]: 0.9 }, confidence: 0.9 };
      else if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 } }; }
      else answers[id] = { score: 0 };
    }
    return { answers, latency_ms: 1, device: 'mock' };
  },
});
const judgeSays = (verdict) => async () => ({ reason: 'r', new: null, question: null, current_fit: null, source: 'llm', ...verdict });
const comfyui = 'm4pro에 comfyui와 블렌더를 세팅하고 3d gen studio를 설치한 후 영상 제작과 게임에셋 제작 워크플로를 작성하여 승인없이 끝까지 자동화해';

// ---- 1. the comfortable model: the judge's level decides, Laya's compressed score does not cap it
let r = await route(store, laya(), uid, claudeOnly, { text: comfyui }, { judge: judgeSays({ agent: 'devops', fit: 0.7, level: 4 }) });
assert.equal(r.scope.depth, 4, r.plan.reason.join(' | '));
assert.equal(r.plan.model, TIER_TABLE[4].claude.model, 'Claude runs it on its strongest model (best = Fable)');
assert.ok(r.plan.reason.some((line) => line === 'judge: comfortable at D4 (Laya D2)'), r.plan.reason.join(' | '));
r = await route(store, laya(), uid, codexOnly, { text: `${comfyui} (codex)` }, { judge: judgeSays({ agent: 'devops', fit: 0.7, level: 4 }), judgeWaitMs: 2000 });
assert.equal(r.plan.model, 'gpt-6-astra', 'Codex runs it on Astra');
// …and a light command runs light even where Laya's score is in the middle
r = await route(store, laya({ kind: 'explain' }), uid, claudeOnly, { text: 'README에 있는 포트 번호 알려줘' }, { judge: judgeSays({ agent: 'generalist', fit: 0.9, level: 0 }) });
assert.equal(r.scope.depth, 0); assert.equal(r.plan.model, 'haiku');
// a verdict without a level (cached before it existed) or no judge at all: Laya's score is the fallback
r = await route(store, laya(), uid, claudeOnly, { text: '로그인 폼 검증 로직 추가' }, { judge: judgeSays({ agent: 'frontend-react', fit: 0.9 }) });
assert.equal(r.scope.depth, 2);
r = await route(store, laya(), uid, claudeOnly, { text: '로그인 폼 검증 로직 추가 (판정 없음)' });
assert.equal(r.scope.depth, 2);
// a forced agent still gets the judge's level (its agent is not used)
r = await route(store, laya(), uid, claudeOnly, { text: '전체 결제 모듈을 새 아키텍처로 마이그레이션', forceAgent: 'backend-node' }, { judge: judgeSays({ agent: 'database', fit: 0.8, level: 4 }) });
assert.equal(r.agent.name, 'backend-node'); assert.equal(r.scope.depth, 4);
// the floors still apply on top of a low level (debug ≥ D2)
r = await route(store, laya({ kind: 'debug' }), uid, claudeOnly, { text: '왜 저장이 안 되는지 봐줘' }, { judge: judgeSays({ agent: 'frontend-react', fit: 0.8, level: 1 }) });
assert.equal(r.scope.depth, 2);
console.log('PASS the model tier comes from the judge\'s comfortable level: D4 runs Fable / Astra, light work runs light');

// ---- 2. handoff: the ComfyUI chat that became security-review's (server session b9344e7c, decisions #2025 → #2274)
const sid = 'sess-comfyui';
store.addRun({ userId: uid, sessionId: sid, agentId: store.agent(uid, 'security-review').id, engine: 'claude', model: 'opus', effort: 'high', depth: 3 });
const asked = [];
const inChat = (verdict) => async (input) => { asked.push(input.current ?? null); return { reason: 'r', new: null, question: null, source: 'llm', ...verdict }; };
// no specialist fits ComfyUI pipelines → a new one is designed and the chat leaves security-review now
r = await route(store, laya({ agent: 'remote-display-sync' }), uid, claudeOnly, { text: 'MPS 지원하는 것만 세팅하도록 해. 목표는 고품질 게임 에셋 생성 그리고 숏드라마 생성이야.', sessionId: sid, sessionEngine: 'claude' },
  { judge: inChat({ agent: null, fit: 0, current_fit: 0.1, level: 4, new: { name: 'genai-media-pipeline', domain: 'generative media', description: 'ComfyUI / Blender asset and video pipelines', technologies: ['ComfyUI', 'Blender'] } }) });
assert.equal(asked.at(-1), 'security-review', 'the judge scores the chat agent');
assert.notEqual(r.agent.name, 'security-review', r.plan.reason.join(' | '));
assert.equal(r.decision, 'create_background'); assert.equal(r.create?.design, true, 'the specialist is designed now');
assert.equal(r.create?.proposal?.name, 'genai-media-pipeline');
assert.ok(r.plan.reason.some((line) => line.startsWith('session agent security-review fits this command poorly (0.10 < 0.6) → handoff to a new genai-media-pipeline')), r.plan.reason.join(' | '));
assert.equal(r.plan.model, 'best', 'and it runs at the comfortable tier');
// an existing specialist that fits takes the chat
r = await route(store, laya({ agent: 'remote-display-sync' }), uid, claudeOnly, { text: 'm4pro에 ComfyUI 도커 컨테이너로 올려줘', sessionId: sid, sessionEngine: 'claude' },
  { judge: inChat({ agent: 'devops', fit: 0.8, current_fit: 0.2, level: 3 }) });
assert.equal(r.agent.name, 'devops');
// nothing fits and nothing to create: the generalist, not the chat's misfit agent
r = await route(store, laya({ agent: 'remote-display-sync' }), uid, claudeOnly, { text: '용량을 충분히 확보했는데 렌더링 설정 최적인지 봐', sessionId: sid, sessionEngine: 'claude' },
  { judge: inChat({ agent: 'generalist', fit: 0.7, current_fit: 0.15, level: 3 }) });
assert.equal(r.agent.name, 'generalist');
// a follow-up the chat's agent carries keeps it
r = await route(store, laya({ agent: 'dotnet-wpf' }), uid, claudeOnly, { text: '진행해봐', sessionId: sid, sessionEngine: 'claude' },
  { judge: inChat({ agent: 'generalist', fit: 0.6, current_fit: 0.85, level: 1 }) });
assert.equal(r.agent.name, 'security-review'); assert.equal(r.scope.depth, 3, 'the chat keeps its tier');
console.log('PASS a chat whose agent does not fit the command is handed off (new, fitting or general agent); a follow-up keeps it');

// ---- 2b. only the judge's view of expertise picks a specialist: the ranker's confident pick alone is never used
const solo = await route(store, laya({ agent: 'database', kind: 'implement' }), uid, claudeOnly, { text: '주문 테이블에 인덱스 추가해줘 (판정 없음)' });
assert.equal(solo.agent.name, 'generalist', solo.plan.reason.join(' | '));
assert.ok(solo.plan.reason.some((line) => line.startsWith('no specialist judge verdict → generalist (ranker had database')));
const poor = await route(store, laya({ agent: 'database' }), uid, claudeOnly, { text: 'SwiftUI 위젯 색 바꿔줘' }, { judge: judgeSays({ agent: 'mobile-responsive', fit: 0.3, level: 1 }) });
assert.equal(poor.agent.name, 'generalist', 'an agent without the expertise is not used for want of a better one');
console.log('PASS a specialist is used only on the judge\'s word that it has the expertise; no verdict or a poor fit → generalist');

// ---- 3. the lexical prior learns only from commands routed to their agent
const answerOf = (id) => store.db.prepare('SELECT answer FROM decision_log WHERE id=?').get(id).answer;
assert.equal(JSON.parse(answerOf(r.decision_id)).agent_source, 'session');
assert.equal(runTeachesAgent(answerOf(r.decision_id)), false, '"진행해봐" never becomes a security-review example');
r = await route(store, laya({ agent: 'database' }), uid, claudeOnly, { text: '주문 테이블 인덱스 설계' }, { judge: judgeSays({ agent: 'database', fit: 0.9, level: 2 }) });
assert.equal(runTeachesAgent(answerOf(r.decision_id)), true, 'a command routed to its agent still teaches it');
assert.equal(runTeachesAgent(null), true); assert.equal(runTeachesAgent('{"agent":"x"}'), true, 'older decisions still teach');
// the judge's own pick is not learned when it is the chat's agent (a follow-up lifts that fit)
const judgedOf = (name) => store.db.prepare("SELECT count(*) n FROM agent_examples WHERE agent_id=? AND source='judge'").get(store.agent(uid, name).id).n;
const before = judgedOf('security-review');
await route(store, laya(), uid, claudeOnly, { text: '그 작업 계속 이어서 해', sessionId: sid, sessionEngine: 'claude' }, { judge: inChat({ agent: 'security-review', fit: 0.85, current_fit: 0.85, level: 2 }) });
assert.equal(judgedOf('security-review'), before);
console.log('PASS routing examples come only from commands routed to their agent, not from a chat that continued');

console.log('capability routing: all checks passed');
