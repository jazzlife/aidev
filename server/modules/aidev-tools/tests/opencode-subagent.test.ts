import assert from 'node:assert/strict';
import test from 'node:test';

import { runOpenCodeTask } from '@/modules/aidev-tools/opencode-subagent.service.js';
import type { OpenCodeSideTurn } from '@/modules/aidev-tools/opencode-side-turn.client.js';

/** OpenCode as a sub-agent: the account's range picks the model, the chat's project is the folder, refusals say so. */
const preview = [0, 1, 2, 3, 4].map((d) => ({ model: d < 2 ? 'opencode-go/deepseek-v4-pro' : 'opencode-go/glm-5.3', effort: d < 4 ? 'high' : 'xhigh' }));
const deps = (over: Partial<Parameters<typeof runOpenCodeTask>[2]> = {}) => {
  const turns: OpenCodeSideTurn[] = [];
  return { turns, deps: { readPolicy: async () => ({ providers: { opencode: { allowed: true, preview } } }), heldUntil: async () => null, ask: async (turn: OpenCodeSideTurn) => { turns.push(turn); return '결론: 테스트 3개 추가, 통과'; }, ...over } };
};

test('a read piece runs under the plan agent in the chat\'s project, on the range\'s pick for its depth', async () => {
  const { turns, deps: d } = deps();
  const result = await runOpenCodeTask({ task: 'src/auth 의 토큰 갱신 흐름을 조사해 보고', mode: 'read', depth: 1 }, { cwd: '/workspace/app', agent: 'backend-node' }, d);
  assert.equal(result.status, 'done');
  assert.equal((result as { report: string }).report, '결론: 테스트 3개 추가, 통과');
  assert.deepEqual([turns[0].access, turns[0].cwd, turns[0].model, turns[0].effort, turns[0].timeoutMs], ['read', '/workspace/app', 'opencode-go/deepseek-v4-pro', 'high', 900_000]);
  assert.match(turns[0].instructions, /서브에이전트/);
  assert.equal(turns[0].prompt, 'src/auth 의 토큰 갱신 흐름을 조사해 보고');
});

test('an edit piece may change files; depth and timeout are clamped', async () => {
  const { turns, deps: d } = deps();
  await runOpenCodeTask({ task: 'x', mode: 'edit', depth: 9, timeoutSec: 99_999 }, {}, d);
  assert.deepEqual([turns[0].access, turns[0].model, turns[0].effort, turns[0].timeoutMs], ['check', 'opencode-go/glm-5.3', 'xhigh', 2_400_000]);
});

test('switched off, on a usage limit, or failing: the worker is told to do the piece itself, and nothing waits', async () => {
  const off = deps({ readPolicy: async () => ({ providers: { opencode: { allowed: false } } }) });
  assert.equal((await runOpenCodeTask({ task: 'x', mode: 'read' }, {}, off.deps)).status, 'unavailable');
  assert.equal(off.turns.length, 0);
  const limited = deps({ heldUntil: async () => Date.now() + 3_600_000 });
  const held = await runOpenCodeTask({ task: 'x', mode: 'read' }, {}, limited.deps);
  assert.equal(held.status, 'limited'); assert.equal(limited.turns.length, 0);
  const failing = deps({ ask: async () => { throw new Error('OpenCode: Too Many Requests (HTTP 429)'); } });
  const failed = await runOpenCodeTask({ task: 'x', mode: 'read' }, {}, failing.deps);
  assert.equal(failed.status, 'failed'); assert.match((failed as { message: string }).message, /HTTP 429.*직접 하세요/);
});
