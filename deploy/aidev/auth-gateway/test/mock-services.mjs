// Local stand-ins for runtime-manager, a CloudCLI runtime and Laya so the gateway can be
// exercised end-to-end off the AI-PC:  node test/mock-services.mjs  (ports 18090 manager+runtime, 18095 laya)
import http from 'node:http';

const managerPort = Number(process.env.MOCK_MANAGER_PORT ?? 18090);
const layaPort = Number(process.env.MOCK_LAYA_PORT ?? 18095);
const codexOnly = new Set((process.env.MOCK_CODEX_ONLY ?? '').split(',').filter(Boolean)); // runtime names whose claude auth is missing
const read = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(c.length ? JSON.parse(Buffer.concat(c)) : {})); });
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

// Heuristic "Laya": keyword scoring so routing tests are deterministic without the model.
const hints = {
  'frontend-react': ['react', 'component', '컴포넌트', 'hook', '훅', 'tsx', 'ui', '화면', 'css', 'tailwind'],
  'backend-node': ['express', 'api', '엔드포인트', 'endpoint', 'server', '서버', 'websocket', 'middleware'],
  database: ['sql', 'sqlite', 'postgres', 'schema', '스키마', 'index', '인덱스', 'migration', '마이그레이션', 'query', '쿼리'],
  devops: ['docker', '도커', 'compose', 'deploy', '배포', 'nginx', 'systemd', 'container', '컨테이너'],
  testing: ['test', '테스트', 'vitest', 'jest', 'playwright', 'e2e', 'coverage'],
  docs: ['readme', '문서', 'document', 'guide', '가이드', 'changelog'],
  'tizen-device': ['tizen', '타이젠', 'sdb', 'wearable', '워치'],
  'android-device': ['android', '안드로이드', 'adb', 'gradle', 'kotlin', 'logcat'],
  'security-review': ['security', '보안', 'vulnerab', '취약', 'csrf', 'injection'],
  'git-workflow': ['git', '깃', 'rebase', 'merge', '충돌', 'branch', '브랜치'],
  'mobile-responsive': ['mobile', '모바일', 'responsive', '반응형', 'pwa', 'safari'],
  'ai-integration': ['llm', 'mcp', 'prompt', '프롬프트', 'agent sdk', 'codex sdk', 'laya'],
};
let lastAgentTop = 0; // set by the agent choice so needs_new can react to it (as the real model would)
function choice(state, q) {
  const text = JSON.stringify(state).toLowerCase();
  const keys = Object.keys(q.criteria);
  const raw = Object.fromEntries(keys.map((k) => [k, 0.2]));
  for (const k of keys) {
    const words = hints[k] ?? [k.toLowerCase(), ...q.criteria[k].toLowerCase().split(/[^a-z가-힣0-9]+/).filter((w) => w.length > 3)];
    for (const w of words) if (text.includes(w)) raw[k] += 3;
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(keys.map((k) => [k, raw[k] / sum]));
  const top = keys.sort((a, b) => probabilities[b] - probabilities[a])[0];
  if (q.instructions.includes('specialist')) lastAgentTop = probabilities[top];
  return { choice: top, probabilities, confidence: probabilities[top] };
}
function score(state, q) {
  const text = JSON.stringify(state).toLowerCase();
  const n = q.criteria.length;
  let idx = 1;
  if (q.instructions.includes('risky')) { idx = /delete|삭제|drop|rm -rf|destroy|force/.test(text) ? 2 : /read|읽|explain|설명|analy|분석|show|보여/.test(text) ? 0 : 1; }
  else if (/delete|삭제|drop|rm -rf|destroy|force/.test(text)) idx = n - 1;
  else if (/explain|설명|what is|뭐야|show|보여|읽어|analy|분석|summar|요약/.test(text)) idx = 0;
  else if (/architect|아키텍처|migrat|마이그레이션|redesign|refactor|리팩터|debug|디버깅|원인/.test(text)) idx = Math.min(n - 1, 3);
  else if (/feature|기능|implement|구현|여러|multiple/.test(text)) idx = Math.min(n - 1, 2);
  idx = Math.min(idx, n - 1);
  const probabilities = Object.fromEntries(q.criteria.map((c, i) => [String(i), i === idx ? 0.7 : 0.3 / (n - 1)]));
  return { score: idx, probabilities, confidence: 0.7 };
}
function noul(state, q) {
  const text = JSON.stringify(state).toLowerCase();
  const ins = q.instructions.toLowerCase();
  if (ins.includes('not in the list')) return { noul: lastAgentTop > 0.5 ? 0.1 : (/unity|셰이더|shader|blender|unreal|cobol|fortran/.test(text) ? 0.85 : 0.1) };
  if (ins.includes('missing')) return { noul: /that file|그 파일|it\b|이거/.test(text) && text.length < 80 ? 0.8 : 0.15 };
  if (ins.includes('two or more')) return { noul: /and|그리고|와 |과 /.test(text) && /db|database|api/.test(text) && /ui|react|화면/.test(text) ? 0.8 : 0.1 };
  if (ins.includes('generalizable')) return { noul: 0.7 };
  // lesson.relevant: overlap between the command and the lesson's trigger (Hangul bigrams + words)
  if (ins.includes('earlier failure')) {
    const grams = (s) => new Set((String(s || '').toLowerCase().match(/[가-힣]{2}|[a-z]{3,}/g) || []));
    const cmd = grams(state.command); const trig = grams(state.trigger);
    const shared = [...trig].filter((g) => cmd.has(g)).length;
    return { noul: shared >= 2 ? 0.85 : 0.1 };
  }
  if (ins.includes('stored knowledge item')) return { noul: /deprecated|renamed|changed/i.test(text) ? 0.9 : 0.5 };
  if (ins.includes('sufficient')) return { noul: 0.6 };
  if (ins.includes('satisfy')) return { noul: /pass|ok|success/.test(text) ? 0.9 : 0.2 };
  return { noul: 0.3 };
}
const laya = http.createServer(async (req, res) => {
  if (req.url === '/health') return send(res, 200, { status: 'ok', loaded: true, device: 'mock', model: 'mock', laya: '0.0' });
  const body = await read(req);
  if (req.url === '/decide') {
    const answers = {};
    for (const [id, q] of Object.entries(body.questions ?? {})) answers[id] = q.type === 'choice' ? choice(body.state, q) : q.type === 'score' ? score(body.state, q) : noul(body.state, q);
    return send(res, 200, { answers, latency_ms: 1, device: 'mock' });
  }
  if (req.url === '/shortlist') return send(res, 200, { keep: Object.keys(body.options).slice(0, body.k ?? 20) });
  send(res, 404, { error: 'not found' });
});
laya.listen(layaPort, () => console.log(`mock laya on ${layaPort}`));

let judgeCalls = 0;
const manager = http.createServer(async (req, res) => {
  const v = req.url.match(/^\/v1\/runtimes\/([^/]+)\/verify$/);
  if (v) { const b = await read(req); return b.token === `rtjwt-${v[1]}` ? send(res, 200, { ok: true, runtime: v[1] }) : send(res, 401, { error: 'Invalid runtime token' }); }
  const m = req.url.match(/^\/v1\/runtimes\/([^/]+)\/(provision|start|delete)$/);
  if (m) return send(res, 200, { target: `http://127.0.0.1:${managerPort}/rt/${m[1]}`, token: `tok-${m[1]}` });
  const r = req.url.match(/^\/rt\/([^/]+)(\/.*)$/);
  if (r) {
    const [, name, path] = r;
    if (path === '/api/auth/user') return send(res, 200, { user: { id: 1, username: name } });
    if (path === '/api/aidev-tools/specialist-judge') {
      // stands in for the runtime's haiku judge: keyword rules over the catalog it is given
      const b = await read(req); judgeCalls++;
      const names = new Set(b.candidates.map((c) => c.name));
      const rules = [[/unity|셰이더/i, [...names].find((n) => n.includes('unity')) ?? null, { name: 'unity-shader', domain: 'unity-graphics', description: 'Unity shaders and URP', technologies: ['Unity', 'HLSL'] }],
        [/verilog|fpga/i, null, { name: 'fpga-verilog', domain: 'hardware', description: 'Verilog / FPGA', technologies: ['Verilog'] }],
        [/swiftui|ios/i, null, { name: 'ios-swift', domain: 'ios', description: 'SwiftUI / iOS apps', technologies: ['Swift', 'SwiftUI'] }],
        [/react|컴포넌트|훅/i, 'frontend-react'], [/express|rate limit|middleware|미들웨어/i, 'backend-node'], [/docker/i, 'devops'], [/adb|logcat|android/i, 'android-device'],
        [/db|migration|마이그레이션|index|인덱스|sql/i, 'database']];
      for (const [re, agent, proposal] of rules) if (re.test(b.command)) return send(res, 200, { success: true, data: agent ? { agent, fit: 0.95, reason: 'mock rule', new: null, engine: 'mock', ms: 5 } : { agent: null, fit: 0, reason: 'mock: no specialist', new: proposal, engine: 'mock', ms: 5 } });
      return send(res, 200, { success: true, data: { agent: 'generalist', fit: 0.7, reason: 'mock: general request', new: null, engine: 'mock', ms: 5 } });
    }
    if (path === '/_mock/judge-calls') return send(res, 200, { calls: judgeCalls });
    if (path === '/api/aidev-tools/knowledge-check') {
      const b = await read(req);
      return /URP/.test(b.title || '')
        ? send(res, 200, { success: true, data: { status: 'changed', summary: 'Blit API renamed in URP 17.1', engine: b.engine, replacement: { title: 'URP 17.1 shader API', body: 'URP 17.1: Blitter.BlitCameraTexture replaced by Blitter.BlitTexture for camera targets.', source_url: 'https://docs.unity3d.com/urp17', source_date: '2026-09-01' } } })
        : send(res, 200, { success: true, data: { status: 'current', summary: 'still valid', replacement: null, engine: b.engine } });
    }
    const a = path.match(/^\/api\/providers\/(\w+)\/auth\/status$/);
    if (a) { const authed = !(a[1] === 'claude' && codexOnly.has(name)); return send(res, 200, { success: true, data: { installed: true, provider: a[1], authenticated: authed, email: authed ? 'x@y' : null, method: authed ? 'oauth' : null } }); }
  }
  send(res, 404, { error: 'not found' });
});
manager.listen(managerPort, () => console.log(`mock manager+runtime on ${managerPort}`));
