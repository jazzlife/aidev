import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLesson } from '@/modules/aidev-tools/lesson-curator.service.js';

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
