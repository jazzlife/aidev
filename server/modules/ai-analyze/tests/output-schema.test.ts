import assert from 'node:assert/strict';
import test from 'node:test';

import { checkSchema, extractJson, schemaSketch, validateAgainstSchema } from '@/modules/ai-analyze/output-schema.js';

/** The contract checker's own "odd" schema (ai-contract-check.mjs ④): every keyword family at once. */
const ODD_SCHEMA = {
  type: 'object',
  required: ['verdict', 'score', 'tags', 'detail'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    score: { type: 'integer', minimum: 0, maximum: 10 },
    tags: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 40 } },
    detail: { type: 'object', required: ['quote'], properties: { quote: { type: ['string', 'null'], maxLength: 300 }, pageNo: { type: ['integer', 'null'] } } },
  },
};

test('the subset is readable, and anything outside it is refused with a reason', () => {
  assert.deepEqual(checkSchema(ODD_SCHEMA), []);
  assert.deepEqual(checkSchema({ type: 'object', additionalProperties: { type: 'number' } }), [], 'an open map');
  assert.match(checkSchema({ type: 'object', patternProperties: { '^x': { type: 'string' } } })[0], /patternProperties/);
  assert.match(checkSchema({ type: 'objekt' })[0], /모르는 type/);
  assert.match(checkSchema({ properties: {} })[0], /type 이 없다/);
  assert.match(checkSchema({ type: 'object', required: ['a'], properties: {} })[0], /required "a"/);
  assert.match(checkSchema({ type: 'array' })[0], /items 가 없다/);
  assert.match(checkSchema('object' as unknown)[0], /객체여야/);
});

test('keyword values are type-checked, so validation never throws on a malformed schema', () => {
  assert.match(checkSchema({ type: 'string', enum: 5 })[0], /enum/);
  assert.match(checkSchema({ type: 'string', enum: [] })[0], /enum/);
  assert.match(checkSchema({ type: 'array', items: { type: 'string' }, maxItems: '3' })[0], /maxItems/);
  assert.match(checkSchema({ type: 'string', maxLength: -1 })[0], /maxLength/);
  assert.match(checkSchema({ type: 'number', minimum: 5, maximum: 1 })[0], /minimum 이 maximum 보다 크다/);
  assert.match(checkSchema({ type: 'number', minimum: 'low' })[0], /minimum/);
});

test('a schema from the network is bounded in depth and size', () => {
  let deep: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 40; i++) deep = { type: 'array', items: deep };
  assert.ok(checkSchema(deep).some((line) => /너무 깊다/.test(line)));
  const wide = { type: 'object', properties: Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`k${i}`, { type: 'string' }])) };
  assert.ok(checkSchema(wide).some((line) => /너무 크다/.test(line)));
});

test('values are validated with readable error lines', () => {
  const good = { verdict: 'yes', score: 3, tags: ['a'], detail: { quote: null } };
  assert.deepEqual(validateAgainstSchema(ODD_SCHEMA, good), []);
  const bad = validateAgainstSchema(ODD_SCHEMA, { verdict: 'maybe', score: 11.5, tags: ['a', 'b', 'c', 'd', 'e'], detail: {}, extra: 1 });
  assert.ok(bad.some((line) => line.startsWith('$.verdict') && /enum/.test(line)), bad.join(' / '));
  assert.ok(bad.some((line) => line.startsWith('$.score') && /integer/.test(line)));
  assert.ok(bad.some((line) => /maxItems 4/.test(line)));
  assert.ok(bad.some((line) => line === '$.detail.quote: 필수인데 없다'));
  assert.ok(bad.some((line) => line === '$.extra: 스키마에 없는 키다'));
  assert.deepEqual(validateAgainstSchema({ type: 'number', minimum: 0 }, 2), [], 'an integer is a number');
});

test('the sketch is derived from the schema', () => {
  const sketch = JSON.parse(schemaSketch(ODD_SCHEMA)) as Record<string, unknown>;
  assert.equal(sketch.verdict, 'yes|no|unknown');
  assert.equal(sketch.score, 'integer 0..10');
  assert.deepEqual(sketch.tags, ['string']);
  assert.deepEqual(sketch.detail, { quote: 'string|null', pageNo: 'integer|null' });
});

test('the first complete JSON value is read out of a reply', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here {not json} is it: {"q":"a } b","n":[1,{"x":"{"}]} and more'), { q: 'a } b', n: [1, { x: '{' }] });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
  assert.equal(extractJson('no json at all'), undefined);
  assert.equal(extractJson('{"open": '), undefined);
});
