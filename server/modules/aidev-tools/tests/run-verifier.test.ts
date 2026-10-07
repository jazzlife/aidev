import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVerificationBrief, parseVerification, verifierModel } from '@/modules/aidev-tools/run-verifier.service.js';

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
