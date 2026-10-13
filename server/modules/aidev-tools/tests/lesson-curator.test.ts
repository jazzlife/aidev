import assert from 'node:assert/strict';
import test from 'node:test';

import { curatorOrder, parseLesson } from '@/modules/aidev-tools/lesson-curator.service.js';

const lesson = { trigger: '테스트 없이 훅을 추가할 때', rule: '기존 컴포넌트의 렌더 계약을 먼저 읽고 최소 변경으로 끝낸다.', engine: null, generalizable: true };

test('parseLesson reads the tagged block', () => {
  const parsed = parseLesson(`머리말\n<aidev-lesson>\n${JSON.stringify(lesson)}\n</aidev-lesson>`);
  assert.equal(parsed?.trigger, lesson.trigger);
  assert.equal(parsed?.rule, lesson.rule);
});

test('parseLesson accepts a json fence and a bare object (small models drop the tags)', () => {
  assert.equal(parseLesson('```json\n' + JSON.stringify(lesson) + '\n```')?.rule, lesson.rule);
  assert.equal(parseLesson(`결과: ${JSON.stringify(lesson)}`)?.trigger, lesson.trigger);
});

test('parseLesson returns null for none / malformed output', () => {
  assert.equal(parseLesson('<aidev-lesson>{"none":true}</aidev-lesson>'), null);
  assert.equal(parseLesson('no lesson here'), null);
  assert.equal(parseLesson('```json\n{"trigger": 1}\n```'), null);
});

test('curatorOrder: the gateway\'s candidates as sent, else the session\'s engine first inside the account\'s engines', () => {
  // no candidates: the session's engine first, the other one as the fallback
  assert.deepEqual(curatorOrder({ engine: 'claude', engines: ['claude', 'codex'] }), [{ engine: 'claude', model: 'haiku' }, { engine: 'codex', model: 'gpt-5.6-luna' }]);
  assert.deepEqual(curatorOrder({ engine: 'codex', engines: ['claude', 'codex'] }).map((c) => c.engine), ['codex', 'claude']);
  // a Codex-only account never gets Claude (D-05)
  assert.deepEqual(curatorOrder({ engine: 'claude', engines: ['codex'] }).map((c) => c.engine), ['codex']);
  // the work order from the gateway: kept as sent, with the policy's model when it carries one
  assert.deepEqual(curatorOrder({ engine: 'claude', engines: ['claude', 'codex'], candidates: [{ engine: 'codex', model: 'gpt-5.6-terra' }, { engine: 'claude', model: null }] }),
    [{ engine: 'codex', model: 'gpt-5.6-terra' }, { engine: 'claude', model: 'haiku' }]);
  assert.deepEqual(curatorOrder({ engine: 'claude', candidates: [] }), [], 'every provider of the order on a usage limit: none');
  // OpenCode: first when it ran the session or is the account's only engine, a fallback only when the gateway named it;
  // its model is the one it starts on unless the gateway sent one
  assert.deepEqual(curatorOrder({ engine: 'opencode', engines: ['claude', 'opencode'] }), [{ engine: 'opencode', model: null }, { engine: 'claude', model: 'haiku' }]);
  assert.deepEqual(curatorOrder({ engine: 'claude', engines: ['opencode'] }), [{ engine: 'opencode', model: null }]);
  assert.deepEqual(curatorOrder({ engine: 'claude', engines: ['claude', 'codex', 'opencode'] }).map((c) => c.engine), ['claude', 'codex', 'opencode']);
  assert.deepEqual(curatorOrder({ engine: 'claude' }).map((c) => c.engine), ['claude', 'codex'], 'an older gateway (no list): Claude and Codex, as before');
  assert.deepEqual(curatorOrder({ engine: 'claude', candidates: [{ engine: 'opencode', model: 'opencode-go/glm-5.3' }] }), [{ engine: 'opencode', model: 'opencode-go/glm-5.3' }]);
});
