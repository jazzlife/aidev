// 2026-10-10: a command in an ongoing chat that needs a specialist the catalog lacks runs on the generalist, and the
// gateway has the runtime design that specialist out of band (POST /api/aidev-tools/design-agent); the draft becomes
// an agent at once. A domain is designed once even when several commands arrive while it is being designed.
//   npm run build && node test/background-design-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bd-'));
const { openStore } = await import('../dist/store.js');
const { seedAgents } = await import('../dist/seed-agents.js');
const { createAidevApi } = await import('../dist/aidev-api.js');
const store = openStore(path.join(dir, 'auth.db'));
store.seedAgents(seedAgents);
await store.add('alice', 'pw1234pw', 'u' + 'a'.repeat(24), 1);
const uid = store.account('alice').id;
const session = { user: { id: uid, username: 'alice', runtime: 'u' + 'a'.repeat(24) }, sid: 's1' };

const laya = {
  status: {},
  predict: async (_state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'depth') answers[id] = { score: 2 };
      else if (id === 'task_kind') answers[id] = { choice: 'explain', probabilities: { explain: 0.9 }, confidence: 0.9 };
      else if (q.type === 'noul') answers[id] = { noul: 0.05 };
      else if (q.type === 'choice') { const k = Object.keys(q.criteria)[0]; answers[id] = { choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 }; }
      else answers[id] = { score: 0 };
    }
    return { answers, latency_ms: 1, device: 'mock' };
  },
};

const proposal = { name: 'binary-protection', domain: 'code protection', description: 'shipping binaries without readable source', technologies: ['Node SEA', 'obfuscation'] };
const draft = { name: 'binary-protection', domain: 'code protection', hint: 'Node SEA obfuscation bytecode packaging', description: 'Ships Node and .NET apps as binaries without readable source. 바이너리 배포, 소스 보호, 난독화.',
  prompt: '당신은 배포 산출물에서 소스 노출을 막는 전문가다. '.repeat(3), tools: null, examples: ['서버를 바이너리로 배포해줘', 'protect the player source'], knowledge: [{ title: 'Node SEA', body: 'the bundle is embedded as is', source_url: 'https://nodejs.org/api/single-executable-applications.html', source_date: '2026-09-01' }], self_check: null };
const designCalls = [];
let releaseDesign;
const runtimeFetch = async (_session, p, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  if (p.startsWith('/api/providers/')) return Response.json({ data: { authenticated: true } });
  if (p === '/api/aidev-tools/specialist-judge') return Response.json({ data: { agent: null, fit: 0, reason: 'no specialist', new: proposal, question: null } });
  if (p === '/api/aidev-tools/design-agent') {
    designCalls.push(body);
    await new Promise((resolve) => { releaseDesign = resolve; });
    return Response.json({ data: { draft, note: null, engine: body.engine, model: body.model } });
  }
  return Response.json({}, { status: 404 });
};
const pushed = [];
const api = createAidevApi({ store, laya, runtimeFetch, json: (res, status, body) => { res.status = status; res.body = body; }, push: { sendToUser: async (u, payload) => { pushed.push({ u, payload }); return { delivered: 1 }; } }, isOnline: () => false });
const post = async (p, body) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.headers = {};
  const res = {};
  await api.handle(req, res, new URL(`http://gw${p}`), session);
  return res;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let r = await post('/api/aidev/route', { text: '서버와 플레이어가 바이너리로 배포된 거 맞지?', sessionId: 'chat-1' });
assert.equal(r.status, 200);
assert.equal(r.body.decision, 'create_background'); assert.equal(r.body.agent.name, 'generalist'); assert.equal(r.body.create.design, true);
await settle();
assert.equal(designCalls.length, 1, 'the specialist is designed out of band');
const call = designCalls[0];
assert.deepEqual([call.engine, call.model, call.session_id, call.proposal.name], ['claude', 'opus', 'chat-1', 'binary-protection'], 'agent design runs at D3 on the account\'s first engine');
assert.deepEqual(call.tools, ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);
assert.match(call.prompt, /전문 agent 설계자/);
assert.match(call.catalog, /generalist:/);

// a second command of the same domain while the first design runs: answered by the generalist, not designed again
r = await post('/api/aidev/route', { text: '플레이어 소스도 안 보이게 해줘', sessionId: 'chat-1' });
assert.equal(r.body.create.design, true);
await settle();
assert.equal(designCalls.length, 1, 'one design per domain at a time');

releaseDesign();
await settle();
const created = store.agent(uid, 'binary-protection');
assert.ok(created, 'the draft became an agent');
assert.equal(created.source, 'generated'); assert.equal(created.owner_id, uid);
assert.equal(store.knowledge(created.id, undefined, uid).length, 1);
console.log('PASS an ongoing chat\'s missing specialist is designed in the background, once, and stored as an agent');

// the domain now has its specialist: no further design
r = await post('/api/aidev/route', { text: '바이너리 난독화 옵션 정리해줘', sessionId: 'chat-2' });
await settle();
assert.equal(designCalls.length, 1, 'an existing agent is not designed again');
console.log('PASS an existing specialist is not designed again');

fs.rmSync(dir, { recursive: true, force: true });
console.log('background design: all checks passed');
process.exit(0);
