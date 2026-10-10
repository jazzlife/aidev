import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDesignRequest, parseAgentDraft } from '@/modules/aidev-tools/agent-designer.service.js';

const block = (body: string) => `설계했습니다.\n<aidev-agent>\n${body}\n</aidev-agent>`;

test('parseAgentDraft reads the architect block and normalizes the name', () => {
  const draft = parseAgentDraft(block(JSON.stringify({ name: 'Binary Protection!', domain: 'code protection', hint: 'Node SEA obfuscation', description: '바이너리 배포 소스 보호', prompt: '당신은 소스 보호 전문가다.', tools: null, examples: ['서버를 바이너리로', 'x'], knowledge: [{ title: 'SEA', body: 'embedded as is', source_url: 'https://nodejs.org' }, { title: 'no body' }], self_check: { task: 'check', expected: 'no source' } })));
  assert.equal(draft?.name, 'binary-protection');
  assert.deepEqual(draft?.examples, ['서버를 바이너리로'], 'examples of 3 characters or fewer are dropped');
  assert.equal(draft?.knowledge.length, 1);
  assert.deepEqual(draft?.self_check, { task: 'check', expected: 'no source' });
});

test('parseAgentDraft repairs a block that lost its closing brackets, and rejects one without a prompt', () => {
  const truncated = parseAgentDraft(block('```json\n{"name":"unity-shader","prompt":"셰이더 전문가","examples":["a long example"]\n```'));
  assert.equal(truncated?.name, 'unity-shader');
  assert.equal(parseAgentDraft(block('{"name":"x"}')), null);
  assert.equal(parseAgentDraft('카탈로그의 기존 agent로 충분합니다.'), null);
});

test('buildDesignRequest hands the architect the command, the catalog and the proposed domain — design only', () => {
  const request = buildDesignRequest({ command: '바이너리로 배포된 거 맞지?', catalog: 'generalist: general help', proposal: { name: 'binary-protection', domain: 'code protection', description: 'no readable source', technologies: ['Node SEA', 'obfuscation'] } });
  assert.match(request, /바이너리로 배포된 거 맞지\?/);
  assert.match(request, /generalist: general help/);
  assert.match(request, /이름 제안: binary-protection/);
  assert.match(request, /핵심 기술: Node SEA, obfuscation/);
  assert.match(request, /원래 명령은 수행하지 않는다/);
  assert.doesNotMatch(buildDesignRequest({ command: 'x', catalog: '', proposal: null }), /이름 제안/);
});
