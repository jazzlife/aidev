import assert from 'node:assert/strict';
import test from 'node:test';

import { parseKnowledgeCheck } from '@/modules/aidev-tools/knowledge-check.service.js';

test('parseKnowledgeCheck reads a tagged changed result with its replacement', () => {
  const parsed = parseKnowledgeCheck(`확인했습니다.\n<aidev-knowledge-check>\n${JSON.stringify({ status: 'changed', summary: 'Blit API가 바뀜', replacement: { title: 'URP 17 Blit', body: 'Use Blitter.BlitCameraTexture in Unity 6.', source_url: 'https://docs.unity3d.com/x', source_date: '2026-08-01' } })}\n</aidev-knowledge-check>`);
  assert.equal(parsed?.status, 'changed');
  assert.equal(parsed?.replacement?.title, 'URP 17 Blit');
  assert.equal(parsed?.replacement?.source_date, '2026-08-01');
});

test('parseKnowledgeCheck accepts a fence or a bare object, and drops unusable replacements', () => {
  assert.equal(parseKnowledgeCheck('```json\n{"status":"current","summary":"ok","replacement":null}\n```')?.status, 'current');
  assert.equal(parseKnowledgeCheck('결과 {"status":"unreachable","summary":"404"}')?.status, 'unreachable');
  const noBody = parseKnowledgeCheck('<aidev-knowledge-check>{"status":"changed","summary":"x","replacement":{"title":"t"}}</aidev-knowledge-check>');
  assert.equal(noBody?.status, 'changed');
  assert.equal(noBody?.replacement, null);
  assert.equal(parseKnowledgeCheck('<aidev-knowledge-check>{"status":"maybe"}</aidev-knowledge-check>'), null);
  assert.equal(parseKnowledgeCheck('nothing here'), null);
});
