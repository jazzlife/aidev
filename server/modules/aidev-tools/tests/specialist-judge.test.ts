import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJudge } from '@/modules/aidev-tools/specialist-judge.service.js';

/** The judge's answer → a verdict the gateway can trust (unknown names count as "none fits"). */
const names = new Set(['frontend-react', 'database']);

test('existing specialist, generalist, and a proposal', () => {
  assert.deepEqual(parseJudge('{"agent":"database","fit":0.9,"reason":"SQL","new":null}', names), { agent: 'database', fit: 0.9, reason: 'SQL', new: null });
  assert.equal(parseJudge('```json\n{"agent":"generalist","fit":0.7,"reason":"trivial","new":null}\n```', names)?.agent, 'generalist');
  const created = parseJudge('Sure: {"agent":null,"fit":0,"reason":"no iOS agent","new":{"name":"iOS Swift!","domain":"ios","description":"SwiftUI apps","technologies":["Swift","SwiftUI"]}}', names);
  assert.equal(created?.agent, null);
  assert.equal(created?.new?.name, 'ios-swift');
});

test('an invented agent name is treated as "no specialist"; garbage is rejected', () => {
  assert.equal(parseJudge('{"agent":"unity-expert","fit":0.9,"reason":"x","new":null}', names)?.agent, null);
  assert.equal(parseJudge('no json here', names), null);
  assert.equal(parseJudge('{"agent":"database","fit":7}', names)?.fit, 1);
});
