import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

/**
 * Provider policy settings (2026-10-13): the screen shows the gateway's view as is — the D0..D4 preview comes from the
 * gateway — and sends one change at a time (work order, a provider's range, a reset to the tier table).
 */
const tierEntry = (models: string[], efforts: string[]) => ({
  mode: 'tier', ladder: null, floor: null, ceiling: null, effort_floor: null, effort_cap: 'xhigh', effort_ladder: efforts,
  preview: [0, 1, 2, 3, 4].map((d) => ({ model: models[Math.min(d, models.length - 1)], effort: 'high', score: null, q2: false, mode: 'tier' })),
  catalog: models.map((model, level) => ({ model, level, efforts, scores: efforts.map((effort) => ({ effort, score: null, estimated: false })) })),
});
const view = (claude: Record<string, unknown> = {}) => ({
  providers: { claude: { ...tierEntry(['haiku', 'sonnet', 'opus', 'best'], ['low', 'medium', 'high', 'xhigh', 'max']), ...claude }, codex: tierEntry(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'], ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) },
  work_priority: [], verify_priority: [], score_index: 'coding',
  scores_source: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai', version: '4.3', synced_at: null },
});
const sent: Array<{ url: string; body: unknown }> = [];
let current = view();
vi.mock('@/shared/api', () => ({
  authenticatedFetch: (url: string, init?: { method?: string; body?: string }) => {
    if (init?.body) sent.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith('/settings/engine-priority')) return Promise.resolve(new Response(JSON.stringify({ engine_priority: ['codex'] })));
    if (init?.method === 'PUT' && url.endsWith('/settings/provider-policy')) {
      current = view({ mode: 'split', ladder: ['haiku', 'sonnet', 'opus', 'best'], preview: [0, 1, 2, 3, 4].map((d) => ({ model: 'opus', effort: d === 4 ? 'xhigh' : 'low', score: null, q2: d === 4, mode: 'steps' })) });
    }
    return Promise.resolve(new Response(JSON.stringify(current)));
  },
}));

const { ProviderPolicyCard, ProviderPolicySettings } = await import('@/modules/aidev-router/ProviderPolicySettings');
const { moveInOrder, policyNote, stepLabel } = await import('@/modules/aidev-router/hooks/useProviderPolicy');

test('moveInOrder and stepLabel', () => {
  assert.deepEqual(moveInOrder(['claude', 'codex'], 'codex', -1), ['codex', 'claude']);
  assert.deepEqual(moveInOrder(['claude', 'codex'], 'claude', -1), ['claude', 'codex'], 'already first');
  assert.equal(stepLabel({ model: 'opus', effort: 'xhigh', q2: true }), 'opus · xhigh (상한·최대)');
  assert.equal(stepLabel(null), '—');
});

test('policyNote: a provider passed over on a usage limit and where the split landed', () => {
  const engines = { claude: { allowed: true, authenticated: true, limited_until: 2000, score: null, notes: [] }, codex: { allowed: true, authenticated: true, score: 0.5, notes: [] } };
  const plan = { engine: 'codex' as const, engine_locked: false, model: 'gpt-5.6-sol', effort: 'medium', target: null, reason: [] };
  assert.equal(policyNote({ plan: { ...plan, step: { index: 4, total: 8, mode: 'steps', q2: false, target: null, score: null } }, engines }, 1000), 'Claude 한도 → Codex · 범위 5/8');
  assert.equal(policyNote({ plan: { ...plan, step: { index: 7, total: 8, mode: 'steps', q2: true, target: null, score: null } }, engines }, 3000), '범위 8/8 · 상한·최대', 'the limit is over');
  assert.equal(policyNote({ plan: { ...plan, step: { index: 2, total: 8, mode: 'score', q2: false, target: 48, score: 48.5 } }, engines }, 3000), '범위 3/8 · 점수 48.5');
  assert.equal(policyNote({ plan, engines }, 3000), null, 'the tier table on the first provider: nothing to say');
});

test('the policy section sends the work order and credits the score source; it holds no provider ranges', async () => {
  const { unmount } = render(<ProviderPolicySettings />);
  await waitFor(() => screen.getByText('자동 (작업 종류별 학습 가중치)'));
  assert.equal(screen.queryByTestId('provider-policy-claude'), null, 'ranges live in each provider\'s tab');
  fireEvent.click(screen.getAllByText('+ Codex')[0]);
  await waitFor(() => assert.ok(sent.some((s) => s.url.endsWith('/settings/engine-priority'))));
  assert.deepEqual(sent.find((s) => s.url.endsWith('/settings/engine-priority'))!.body, { order: ['codex'] });
  assert.ok(screen.getByRole('link', { name: 'Artificial Analysis' }), 'the score source is credited');
  unmount();
});

test('a provider\'s range tab shows the gateway preview and sends its range', async () => {
  render(<ProviderPolicyCard engine="claude" />);
  await waitFor(() => screen.getByTestId('provider-policy-claude'));
  assert.match(screen.getByTestId('provider-preview-claude').textContent ?? '', /D0.*Haiku/);
  assert.equal(screen.queryByTestId('provider-policy-codex'), null, 'only the selected provider');
  // "범위 설정" turns the tier table into the split over the catalog ladder
  fireEvent.click(screen.getByText('범위 설정'));
  await waitFor(() => assert.match(screen.getByTestId('provider-preview-claude').textContent ?? '', /상한·최대/));
  assert.deepEqual(sent.find((s) => s.url.endsWith('/settings/provider-policy'))!.body, { engine: 'claude', ladder: ['haiku', 'sonnet', 'opus', 'best'] });
  assert.ok(screen.getByText('등급표로 되돌리기'));
});
