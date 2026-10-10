import assert from 'node:assert/strict';
import test from 'node:test';

import { firstCompleteJson, parseJudge } from '@/modules/aidev-tools/specialist-judge.service.js';

/** The judge's answer → a verdict the gateway can trust (unknown names count as "none fits"). */
const names = new Set(['frontend-react', 'database']);

test('existing specialist, generalist, and a proposal', () => {
  assert.deepEqual(parseJudge('{"agent":"database","fit":0.9,"reason":"SQL","new":null}', names), { agent: 'database', fit: 0.9, reason: 'SQL', new: null, question: null });
  assert.equal(parseJudge('```json\n{"agent":"generalist","fit":0.7,"reason":"trivial","new":null}\n```', names)?.agent, 'generalist');
  const created = parseJudge('Sure: {"agent":null,"fit":0,"reason":"no iOS agent","new":{"name":"iOS Swift!","domain":"ios","description":"SwiftUI apps","technologies":["Swift","SwiftUI"]}}', names);
  assert.equal(created?.agent, null);
  assert.equal(created?.new?.name, 'ios-swift');
});

test('a low-fit closest agent keeps the proposal next to it; the gateway decides by the fit', () => {
  const low = parseJudge('{"agent":"frontend-react","fit":0.15,"reason":"React is not SwiftUI","new":{"name":"ios-swift","domain":"ios","description":"SwiftUI apps","technologies":["Swift"]}}', names);
  assert.deepEqual([low?.agent, low?.fit, low?.new?.name], ['frontend-react', 0.15, 'ios-swift']);
  assert.equal(parseJudge('{"agent":"generalist","fit":0.8,"reason":"x","new":{"name":"y","domain":"z"}}', names)?.new, null, 'the generalist never carries a proposal');
});

test('an invented agent name is treated as "no specialist"; garbage is rejected', () => {
  assert.equal(parseJudge('{"agent":"unity-expert","fit":0.9,"reason":"x","new":null}', names)?.agent, null);
  assert.equal(parseJudge('no json here', names), null);
  // the clarifying question is kept (trimmed, capped) and an empty one means none
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"question":"  어느 테이블인가요? "}', names)?.question, '어느 테이블인가요?');
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null,"question":""}', names)?.question, null);
  assert.equal(parseJudge('{"agent":"database","fit":7}', names)?.fit, 1);
});

test('the streamed verdict is complete at the first balanced object (the judge stops reading there)', () => {
  assert.equal(firstCompleteJson('```json\n{"agent":"database","fit":0.9'), null);
  assert.deepEqual(firstCompleteJson('```json\n{"agent":"database","fit":0.9,"reason":"a } in \\"text\\"","new":null}\n``` The command asks'), { agent: 'database', fit: 0.9, reason: 'a } in "text"', new: null });
  assert.equal(firstCompleteJson('{"agent":null,"new":{"name":"x","technologies":["a"]}} and {"more":1}')?.agent, null);
  assert.equal(parseJudge('{"agent":"database","fit":0.9,"reason":"x","new":null}\nNote: {see above}', names)?.agent, 'database');
});
