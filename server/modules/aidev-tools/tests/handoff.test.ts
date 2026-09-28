import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHandoffBrief } from '@/modules/aidev-tools/handoff.service.js';

test('buildHandoffBrief carries the requests, changed files, commands, errors and last answer', () => {
  const brief = buildHandoffBrief([
    { kind: 'text', role: 'user', content: 'react로 todo 앱 만들어줘' },
    { kind: 'tool_use', toolName: 'Write', toolInput: { file_path: 'src/App.tsx', content: '...' } },
    { kind: 'tool_use', toolName: 'Bash', toolInput: JSON.stringify({ command: 'npm test' }) },
    { kind: 'tool_result', toolResult: { isError: true, content: 'FAIL src/App.test.tsx' } },
    { kind: 'text', role: 'assistant', content: '테스트가 실패했습니다.' },
    { kind: 'text', role: 'user', content: '테스트 고쳐줘' },
    { kind: 'tool_use', toolName: 'apply_patch', toolInput: { path: 'src/App.tsx' } },
  ], { fromEngine: 'claude', toEngine: 'codex', reason: 'claude가 막힘' });
  assert.match(brief.text, /claude → codex/);
  assert.match(brief.text, /원래 요청: react로 todo 앱/);
  assert.match(brief.text, /마지막 요청: 테스트 고쳐줘/);
  assert.match(brief.text, /- npm test/);
  assert.match(brief.text, /FAIL src\/App\.test\.tsx/);
  assert.match(brief.text, /마지막 응답[\s\S]*테스트가 실패했습니다/);
  assert.deepEqual(brief.files, ['src/App.tsx']);
  assert.equal(brief.userTurns, 2);
});

test('buildHandoffBrief works on an empty transcript', () => {
  const brief = buildHandoffBrief([], { fromEngine: null, toEngine: null, reason: null });
  assert.match(brief.text, /원래 요청: \(알 수 없음\)/);
  assert.match(brief.text, /수정한 파일: 없음/);
});
