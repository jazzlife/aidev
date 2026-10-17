import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { routingStore } from '@/modules/aidev-router/store';

/**
 * A model, effort, engine or agent picked by hand holds for its chat only (2026-10-17): another chat is routed
 * afresh, while the chat the app continues in (a new chat's id, a handoff) keeps the picks.
 */
beforeEach(() => { routingStore.patch({ overrides: {}, overridesSessionId: null }); routingStore.followSession('a'); });

test('opening another chat drops the picks, the PC pick excepted', () => {
  routingStore.setOverrides({ model: 'opus', effort: 'max', engine: 'claude', agent: 'frontend', targetId: 3 });
  routingStore.followSession('b');
  assert.deepEqual(routingStore.get().overrides, { targetId: 3 });
  routingStore.setOverrides({ model: 'sonnet' });
  routingStore.followSession(null);
  assert.deepEqual(routingStore.get().overrides, { targetId: 3 });
});

test('the same chat keeps them', () => {
  routingStore.setOverrides({ model: 'opus' });
  routingStore.followSession('a');
  assert.deepEqual(routingStore.get().overrides, { model: 'opus' });
});

test('a new chat that gets its id, or a handoff session, carries them over', () => {
  routingStore.followSession(null);
  routingStore.setOverrides({ effort: 'high' });
  routingStore.adoptSession('new-1');
  routingStore.followSession('new-1');
  assert.deepEqual(routingStore.get().overrides, { effort: 'high' });
  routingStore.adoptSession('handoff-2');
  routingStore.followSession('handoff-2');
  assert.deepEqual(routingStore.get().overrides, { effort: 'high' });
});
