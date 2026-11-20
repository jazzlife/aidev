import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVerificationBrief, parseVerification, verifiedTurn, verifierCandidates, verifierEngineOrder, verifierModel } from '@/modules/aidev-tools/run-verifier.service.js';

const verdict = { verdict: 'fail', summary: '테스트가 통과했다는 주장이 틀렸다', checked: [{ claim: 'npm test 통과', result: 'wrong', evidence: 'npm test → 2 failed' }], issues: ['GameLoop.cs의 타이머가 60fps를 보장하지 않음'] };

test('parseVerification reads the tagged block, a json fence and a bare object', () => {
  const tagged = parseVerification(`확인 결과\n<aidev-verify>\n${JSON.stringify(verdict)}\n</aidev-verify>`);
  assert.equal(tagged?.verdict, 'fail');
  assert.equal(tagged?.checked[0]?.result, 'wrong');
  assert.deepEqual(tagged?.issues, verdict.issues);
  assert.equal(parseVerification('```json\n' + JSON.stringify(verdict) + '\n```')?.summary, verdict.summary);
  assert.equal(parseVerification(`결과: ${JSON.stringify({ ...verdict, verdict: 'pass' })}`)?.verdict, 'pass');
});

test('parseVerification rejects an unknown verdict and malformed output; odd check results become unverified', () => {
  assert.equal(parseVerification('{"verdict":"maybe"}'), null);
  assert.equal(parseVerification('no block here'), null);
  const loose = parseVerification(JSON.stringify({ verdict: 'unclear', checked: [{ claim: 'x', result: 'sure' }, { nope: 1 }], issues: ['', 3, 'real'] }));
  assert.equal(loose?.checked.length, 1);
  assert.equal(loose?.checked[0]?.result, 'unverified');
  assert.deepEqual(loose?.issues, ['real']);
});

test('verifierModel never goes below opus/sol, follows a stronger worker and the user floor', () => {
  assert.equal(verifierModel('claude', { workerEngine: 'claude', workerModel: 'sonnet', floor: undefined }), 'opus');
  assert.equal(verifierModel('claude', { workerEngine: 'claude', workerModel: 'best', floor: undefined }), 'best');
  assert.equal(verifierModel('claude', { workerEngine: 'claude', workerModel: 'fable', floor: undefined }), 'best');
  assert.equal(verifierModel('claude', { workerEngine: 'codex', workerModel: 'gpt-6-astra', floor: 'best' }), 'best');
  // a Codex worker's model does not rank on Claude's ladder: the rung is the minimum
  assert.equal(verifierModel('claude', { workerEngine: 'codex', workerModel: 'gpt-6-astra', floor: undefined }), 'opus');
  assert.equal(verifierModel('codex', { workerEngine: 'codex', workerModel: 'gpt-5.6-terra', floor: undefined }), 'gpt-5.6-sol');
  assert.equal(verifierModel('codex', { workerEngine: 'codex', workerModel: 'gpt-6-astra', floor: undefined }), 'gpt-6-astra');
});

test('verifierEngineOrder prefers the worker\'s other engine and stays inside the usable ones', () => {
  assert.deepEqual(verifierEngineOrder('claude', ['claude', 'codex']), ['codex', 'claude']);
  assert.deepEqual(verifierEngineOrder('codex', ['claude', 'codex']), ['claude', 'codex']);
  // only the worker's own engine usable: the check still runs there (as another agent)
  assert.deepEqual(verifierEngineOrder('codex', ['codex']), ['codex']);
  // the other engine is limited or signed out: it is not offered
  assert.deepEqual(verifierEngineOrder('claude', ['claude']), ['claude']);
  assert.deepEqual(verifierEngineOrder(null, ['codex']), ['codex']);
  assert.deepEqual(verifierEngineOrder('claude', []), []);
  // Codex this runtime saw refuse its sign-in (a lapsed subscription) is not tried, even when the gateway still lists it
  assert.deepEqual(verifierEngineOrder('claude', ['claude', 'codex'], { signedOut: true }), ['claude']);
  assert.deepEqual(verifierEngineOrder('codex', ['claude', 'codex'], { signedOut: true }), ['claude']);
  assert.deepEqual(verifierEngineOrder(null, ['codex'], { signedOut: true }), []);
  // Codex at capacity lately goes last: the check runs on the worker's own engine as another agent first
  assert.deepEqual(verifierEngineOrder('claude', ['claude', 'codex'], { busy: true }), ['claude', 'codex']);
  assert.deepEqual(verifierEngineOrder('codex', ['codex'], { busy: true }), ['codex']);
  // OpenCode: checked by Claude, then Codex; it checks last (its model's strength is unknown here), or alone
  assert.deepEqual(verifierEngineOrder('opencode', ['claude', 'codex', 'opencode']), ['claude', 'codex', 'opencode']);
  assert.deepEqual(verifierEngineOrder('claude', ['claude', 'codex', 'opencode']), ['codex', 'claude', 'opencode']);
  assert.deepEqual(verifierEngineOrder('opencode', ['opencode']), ['opencode']);
});

test('buildVerificationBrief covers only the last turn: its files, commands, errors and the final report', () => {
  const messages = [
    { kind: 'text', role: 'user', content: '이전 명령' },
    { kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'old.ts' } },
    { kind: 'text', role: 'assistant', content: '이전 보고' },
    { kind: 'text', role: 'user', content: '플레이어를 60fps로 만들어' },
    { kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'player/GameLoop.cs' } },
    { kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'dotnet build' } },
    { kind: 'tool_result', toolResult: { isError: true, content: 'error CS1002' } },
    { kind: 'text', role: 'assistant', content: '진행 중…' },
    { kind: 'text', role: 'assistant', content: 'GameLoop.cs를 고쳤고 빌드가 통과했습니다.' },
  ];
  const brief = buildVerificationBrief(messages, { command: null, agent: 'game-loop-player', engine: 'claude', model: 'sonnet' });
  assert.deepEqual(brief.files, ['player/GameLoop.cs']);
  assert.match(brief.text, /플레이어를 60fps로 만들어/);
  assert.match(brief.text, /dotnet build/);
  assert.match(brief.text, /error CS1002/);
  assert.match(brief.text, /빌드가 통과했습니다/);
  assert.doesNotMatch(brief.text, /old\.ts|이전 보고/);
  assert.match(brief.text, /game-loop-player · claude sonnet/);
});

test('verifierCandidates follows the gateway\'s order with its models and efforts, else the runtime\'s own order', () => {
  const base = { engine: 'claude' as const, engines: ['claude', 'codex'] as Array<'claude' | 'codex' | 'opencode'>, workerModel: 'opus', modelFloor: {} };
  // no candidates: the runtime's order (other engine first) with verifierModel and no effort
  assert.deepEqual(verifierCandidates({ ...base, candidates: null }), [{ engine: 'codex', model: 'gpt-5.6-sol', effort: null }, { engine: 'claude', model: 'opus', effort: null }]);
  // the verification order as the gateway sent it — the worker's own provider first when the user put it first
  const candidates = [{ engine: 'claude' as const, model: 'opus', effort: 'medium' }, { engine: 'codex' as const, model: null, effort: null }];
  assert.deepEqual(verifierCandidates({ ...base, candidates }), [{ engine: 'claude', model: 'opus', effort: 'medium' }, { engine: 'codex', model: 'gpt-5.6-sol', effort: null }]);
  // this runtime's knowledge of Codex still applies: signed out → dropped, at capacity → last
  assert.deepEqual(verifierCandidates({ ...base, candidates: [...candidates].reverse() }, { signedOut: true }).map((c) => c.engine), ['claude']);
  assert.deepEqual(verifierCandidates({ ...base, candidates: [...candidates].reverse() }, { busy: true }).map((c) => c.engine), ['claude', 'codex']);
  // OpenCode: the gateway's model and effort as sent; without one, the model OpenCode starts on (null)
  assert.deepEqual(verifierCandidates({ ...base, candidates: [{ engine: 'opencode', model: 'opencode-go/glm-5.3', effort: 'high' }] }), [{ engine: 'opencode', model: 'opencode-go/glm-5.3', effort: 'high' }]);
  assert.deepEqual(verifierCandidates({ ...base, engine: 'opencode', engines: ['opencode'], candidates: null }), [{ engine: 'opencode', model: null, effort: null }]);
});

test('buildVerificationBrief carries the platform tools the worker used and what they returned', () => {
  const brief = buildVerificationBrief([
    { kind: 'text', role: 'user', content: 'OpenCode에게 notes.txt를 읽게 해' },
    { kind: 'tool_use', toolName: 'mcp__aidev-tools__opencode_task', toolInput: { task: 'read notes.txt', mode: 'read' }, toolResult: { content: '{"status":"done","model":"opencode-go/kimi-k3","report":"KIWI"}' } },
    { kind: 'tool_use', toolName: 'Read', toolInput: { file_path: 'notes.txt' }, toolResult: { content: 'KIWI' } },
    { kind: 'text', role: 'assistant', content: 'KIWI (opencode-go/kimi-k3)' },
  ], { command: null, agent: 'generalist', engine: 'claude', model: 'sonnet' });
  assert.match(brief.text, /## 작업자가 쓴 플랫폼 도구와 그 결과[^\n]*\n- opencode_task \{"task":"read notes.txt","mode":"read"\} → \{"status":"done","model":"opencode-go\/kimi-k3","report":"KIWI"\}/);
  assert.doesNotMatch(brief.text, /- Read /, 'ordinary tools are not listed there');
});

test('verifiedTurn pins the run\'s own turn and sees when the chat went on past it', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 19, 0, 0, seconds)).toISOString();
  const startedAt = Date.parse(at(10));
  const messages = [
    { kind: 'text', role: 'user', content: '이전 명령', timestamp: at(0) },
    { kind: 'text', role: 'assistant', content: '이전 보고', timestamp: at(5) },
    { kind: 'text', role: 'user', content: '로그인 화면 고쳐', timestamp: at(11) },
    { kind: 'tool_use', toolName: 'Edit', toolInput: { file_path: 'login.tsx' }, timestamp: at(12) },
    { kind: 'text', role: 'assistant', content: 'login.tsx를 고쳤습니다.', timestamp: at(20) },
  ];
  const own = verifiedTurn(messages, startedAt);
  assert.equal(own.movedOn, false);
  assert.equal(own.turn[0]?.content, '로그인 화면 고쳐');
  // the user's next command (typed, or queued during the run and sent by the server) is already in the chat
  const went = verifiedTurn([...messages, { kind: 'text', role: 'user', content: '이제 회원가입도', timestamp: at(30) }, { kind: 'text', role: 'assistant', content: '진행 중…', timestamp: at(31) }], startedAt);
  assert.equal(went.movedOn, true);
  assert.equal(went.turn.at(-1)?.content, 'login.tsx를 고쳤습니다.', 'the turn stops before the next command');
  const brief = buildVerificationBrief([...messages, { kind: 'text', role: 'user', content: '이제 회원가입도', timestamp: at(30) }], { command: null, agent: 'frontend-react', engine: 'claude', model: 'opus', startedAt });
  assert.match(brief.text, /로그인 화면 고쳐/);
  assert.doesNotMatch(brief.text, /회원가입/);
  // no start time (an older gateway): the newest turn, as before
  assert.equal(verifiedTurn(messages, null).turn[0]?.content, '로그인 화면 고쳐');
  // an image-only command opens a turn too
  const imageOnly = verifiedTurn([...messages.slice(0, 2), { kind: 'text', role: 'user', content: '', images: [{ data: 'data:image/png;base64,AAAA' }], timestamp: at(11) }], startedAt);
  assert.equal(imageOnly.turn.length, 1);
});

test('buildVerificationBrief lists the command\'s images and files for the verifier to open', () => {
  const brief = buildVerificationBrief([
    { kind: 'text', role: 'user', content: '첨부한 화면처럼 바꿔', images: [{ data: 'data:image/png;base64,AAAA' }], files: [{ path: '/home/cloudcli/.cloudcli/assets/spec.pdf', name: 'spec.pdf' }] },
    { kind: 'text', role: 'assistant', content: '바꿨습니다.' },
  ], { command: null, agent: 'generalist', engine: 'claude', model: 'opus', imageFiles: ['/tmp/aidev-verify/7/image-1.png'] });
  assert.match(brief.text, /## 명령에 첨부된 이미지[^\n]*\n- \/tmp\/aidev-verify\/7\/image-1\.png/);
  assert.match(brief.text, /## 명령에 첨부된 파일\n- \/home\/cloudcli\/\.cloudcli\/assets\/spec\.pdf/);
});

test('a turn that changed no project file has nothing to verify (a review, an analysis, a plan)', () => {
  const brief = (tools: Array<Record<string, unknown>>) => buildVerificationBrief([
    { kind: 'text', role: 'user', content: '코드 수정은 하지 말고 구조만 검토해' },
    ...tools.map((tool) => ({ kind: 'tool_use', ...tool })),
    { kind: 'text', role: 'assistant', content: '검토 결과입니다.' },
  ], { command: null, agent: 'backend-node', engine: 'claude', model: 'opus' }).changedProject;
  // reading and running checks only (runs 2705–2707: a review failed and sent back until it was implemented)
  assert.equal(brief([{ toolName: 'Read', toolInput: { file_path: 'src/server.ts' } }, { toolName: 'Bash', toolInput: { command: 'grep -rn status src' } }]), false);
  // a plan or a memory note is the agent's own file, not work on the project
  assert.equal(brief([{ toolName: 'Write', toolInput: { file_path: '/home/cloudcli/.claude/plans/review.md' } }, { toolName: 'Write', toolInput: { file_path: '/home/cloudcli/.claude/projects/-x/memory/rule.md' } }]), false);
  // an edit (Codex patches are normalized to Edit/Write), an OpenCode patch, or work recorded in git
  assert.equal(brief([{ toolName: 'Edit', toolInput: JSON.stringify({ file_path: 'src/server.ts' }) }]), true);
  assert.equal(brief([{ toolName: 'Patch', toolInput: { files: ['src/server.ts'] } }]), true);
  assert.equal(brief([{ toolName: 'Bash', toolInput: { command: "sed -i 's/a/b/' src/x.ts && git commit -am fix" } }]), true);
});
