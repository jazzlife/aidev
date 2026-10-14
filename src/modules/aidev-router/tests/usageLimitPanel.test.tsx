import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

/** The drawers show the signed-in engines' usage only; with none signed in, not even the heading (2026-10-13). */
let providers: Record<string, unknown> = {};
vi.mock('@/shared/api', () => ({
  api: { providers: { usageLimits: () => Promise.resolve({ json: () => Promise.resolve({ success: true, data: { providers } }) }) } },
}));

const { UsageLimitPanel, formatObservedAt } = await import('@/modules/aidev-router/UsageLimitPanel');
const framed = () => render(<UsageLimitPanel frame={(panel) => <section data-testid="frame"><h2>계정 한도</h2>{panel}</section>} />);

test('nothing signed in → no panel and no frame', async () => {
  providers = {};
  const { container } = framed();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(container.innerHTML, '');
});

test('only the engines the runtime reports are drawn', async () => {
  providers = { claude: { provider: 'claude', observedAt: 0, windows: [], blockedUntil: null } };
  framed();
  await waitFor(() => screen.getByTestId('frame'));
  assert.ok(screen.getByTestId('usage-claude'));
  assert.equal(screen.queryByTestId('usage-codex'), null);
});

test('figures read a while ago say when: today by time, yesterday, else the date', () => {
  const now = new Date(2026, 9, 14, 9, 30).getTime();
  assert.equal(formatObservedAt(new Date(2026, 9, 14, 8, 5).getTime(), now), '08:05');
  assert.equal(formatObservedAt(new Date(2026, 9, 13, 23, 16).getTime(), now), '어제 23:16');
  assert.equal(formatObservedAt(new Date(2026, 9, 11, 7, 0).getTime(), now), '10/11 07:00');
});
