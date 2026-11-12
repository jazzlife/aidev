import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { chatRouteOf, routingStore } from '@/modules/aidev-router/store';

/**
 * A model, effort, engine or agent picked by hand holds for its chat only (2026-10-17): another chat is routed
 * afresh, while the chat the app continues in (a new chat's id, a handoff) keeps the picks.
 */
beforeEach(() => { routingStore.patch({ overrides: {}, overridesSessionId: null, savedOverrides: {}, routes: {} }); routingStore.followSession('a'); });

test('opening another chat drops the picks, the PC pick excepted', () => {
  routingStore.setOverrides({ model: 'opus', effort: 'max', engine: 'claude', agent: 'frontend', targetId: 3 });
  routingStore.followSession('b');
  assert.deepEqual(routingStore.get().overrides, { targetId: 3 });
  routingStore.setOverrides({ model: 'sonnet' });
  routingStore.followSession(null);
  assert.deepEqual(routingStore.get().overrides, { targetId: 3 });
});

test('coming back to a chat restores its own picks, and the chat left keeps its own', () => {
  routingStore.setOverrides({ model: 'opus', agent: 'frontend', targetId: 3 });
  routingStore.followSession('b');
  routingStore.setOverrides({ model: 'sonnet', agent: 'backend' });
  routingStore.followSession('a');
  assert.deepEqual(routingStore.get().overrides, { model: 'opus', agent: 'frontend', targetId: 3 });
  routingStore.followSession('b');
  assert.deepEqual(routingStore.get().overrides, { model: 'sonnet', agent: 'backend', targetId: 3 });
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

test('each chat shows its own last route, and a new chat\'s becomes the chat\'s once it has an id', () => {
  const routed = (decisionId: number, agent: string) => ({ route: { decision_id: decisionId, agent: { name: agent } } as never, text: agent, runId: decisionId, finishedAt: null, feedback: null });
  routingStore.setFor('routes', 'a', routed(1, 'frontend'));
  routingStore.setFor('routes', null, routed(2, 'backend'));
  routingStore.adoptSession('new-2');
  assert.equal(chatRouteOf(routingStore.get(), 'new-2')?.route.agent.name, 'backend');
  assert.equal(chatRouteOf(routingStore.get(), 'a')?.route.agent.name, 'frontend', 'chat A still shows its own');
  assert.equal(chatRouteOf(routingStore.get(), null), null);
  routingStore.adoptSession('handoff-3');
  assert.equal(chatRouteOf(routingStore.get(), 'handoff-3'), null, 'a chat nothing was routed in shows none');
});

test('a new chat that gets its id after the user opened another chat leaves that chat\'s picks alone', () => {
  routingStore.followSession(null);
  routingStore.patch({ sent: { '': { runId: 9, text: '새 채팅 명령', agent: null, reported: false } } });
  routingStore.followSession('b');
  routingStore.setOverrides({ model: 'opus' });
  routingStore.adoptSession('new-3', false);
  routingStore.followSession('b');
  assert.deepEqual(routingStore.get().overrides, { model: 'opus' }, 'chat B keeps its pick');
  routingStore.followSession('new-3');
  assert.deepEqual(routingStore.get().overrides, {}, 'the new chat had no pick of chat B');
  assert.equal(routingStore.get().sent['new-3']?.runId, 9, 'the new chat\'s send is still its own');
  routingStore.patch({ sent: {} });
});
