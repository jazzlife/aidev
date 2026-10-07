import assert from 'node:assert/strict';

import { test } from 'vitest';

import { stripAgentArchitectBlock, stripProposedPlanEnvelope } from '@/modules/chat/utils/chatFormatting';

test('stripProposedPlanEnvelope removes a complete outer plan envelope', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Session Timeline\n\nPlan body\n</proposed_plan>'),
    '# Session Timeline\n\nPlan body',
  );
});

test('stripProposedPlanEnvelope removes the opening tag while a plan is streaming', () => {
  assert.equal(
    stripProposedPlanEnvelope('<proposed_plan>\n# Partial plan'),
    '# Partial plan',
  );
});

test('stripProposedPlanEnvelope preserves tags that are not the outer envelope', () => {
  const content = 'Use `<proposed_plan>` only for plans.';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

test('stripProposedPlanEnvelope preserves an unmatched terminal closing tag', () => {
  const content = 'Ordinary text that mentions a terminal tag.\n</proposed_plan>';
  assert.equal(stripProposedPlanEnvelope(content), content);
});

test('stripAgentArchitectBlock removes a complete design block', () => {
  assert.equal(
    stripAgentArchitectBlock('<aidev-agent>\n{"name":"foo"}\n</aidev-agent>'),
    '',
  );
});

test('stripAgentArchitectBlock keeps minimal surrounding text, drops the block', () => {
  assert.equal(
    stripAgentArchitectBlock('새 전문 agent를 설계했습니다.\n<aidev-agent>\n{"name":"foo"}\n</aidev-agent>'),
    '새 전문 agent를 설계했습니다.',
  );
});

test('stripAgentArchitectBlock drops everything from an opening tag while streaming', () => {
  assert.equal(
    stripAgentArchitectBlock('<aidev-agent>\n{"name":"fo'),
    '',
  );
});

test('stripAgentArchitectBlock leaves ordinary text untouched', () => {
  const content = '그 설정은 전역 기본값이 아직 없습니다.';
  assert.equal(stripAgentArchitectBlock(content), content);
});

test('stripAgentArchitectBlock preserves ordinary whitespace', () => {
  const content = '설정이 저장되었습니다.\n';
  assert.equal(stripAgentArchitectBlock(content), content);
});
