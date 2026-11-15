import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import type { AiAnalyzeModelPick, AiAnalyzeTurnRequest, AiAnalyzeTurnResult } from '@/shared/types.js';
import { createAnalysisResultsStore } from '@/modules/ai-analyze/analysis-results.store.js';
import { createAiAnalyzeService, requestFingerprint } from '@/modules/ai-analyze/ai-analyze.service.js';

type Turn = (request: AiAnalyzeTurnRequest) => Promise<AiAnalyzeTurnResult>;
const answer = (text: string, costUsd = 0.01): AiAnalyzeTurnResult => ({ ok: true, text, model: 'claude-sonnet-x', sessionId: 's1', costUsd, durationMs: 5 });

function setup(options: { turn?: Turn; pick?: () => Promise<AiAnalyzeModelPick>; db?: Database.Database; maxQueued?: number } = {}) {
  const db = options.db ?? new Database(':memory:');
  const turns: AiAnalyzeTurnRequest[] = [];
  const service = createAiAnalyzeService({
    store: createAnalysisResultsStore(() => db),
    runTurn: async (request) => { turns.push(request); return (options.turn ?? (async () => answer('hello')))(request); },
    pickModel: options.pick ?? (async () => ({ ok: true, model: 'sonnet', effort: 'high' })),
    maxQueued: options.maxQueued,
  });
  /** polls until the job leaves `running` (the fake turns resolve at once) */
  const settle = async (jobId: string) => {
    for (let i = 0; i < 100; i++) {
      const reply = service.poll(jobId);
      if (reply.body.status !== 'running') return reply;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('job never finished');
  };
  const run = async (body: Record<string, unknown>) => {
    const submitted = service.submit(body);
    assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
    return settle(String(submitted.body.jobId));
  };
  return { db, service, turns, settle, run };
}

const SCHEMA = { type: 'object', required: ['quote'], additionalProperties: false, properties: { quote: { type: ['string', 'null'], maxLength: 50 } } };
const textBody = (requestId: string, prompt = 'say hello') => ({ requestId, task: { system: 's', prompt }, output: { format: 'text' } });
const jsonBody = (requestId: string, extra: Record<string, unknown> = {}) => ({ requestId, task: { system: 's', prompt: 'find the word', effort: 'high' }, output: { format: 'json', schema: SCHEMA, schemaName: 'test.quote.v1' }, ...extra });
const pdfBase64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1').toString('base64');

test('a text request becomes a job and its answer is polled back', async () => {
  const { service, run, turns } = setup();
  const done = await run(textBody('t1'));
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.ok, done.body.status, done.body.text, done.body.costUsd], [true, 'done', 'hello', 0.01]);
  assert.equal(turns[0].prompt, 'say hello', 'a text answer gets the task as is');
  assert.deepEqual([turns[0].model, turns[0].effort], ['sonnet', 'high'], 'the account pick is what runs');
  assert.equal(service.poll('job_nope').status, 404);
});

test('a JSON request answers with data that passed the declared schema, and keeps the raw text', async () => {
  const { run, turns } = setup({ turn: async () => answer('```json\n{"quote":"SECRET-1"}\n```') });
  const done = await run(jsonBody('j1'));
  assert.deepEqual(done.body.data, { quote: 'SECRET-1' });
  assert.equal(done.body.text, '```json\n{"quote":"SECRET-1"}\n```');
  assert.equal(done.body.schemaName, 'test.quote.v1');
  assert.match(turns[0].prompt, /JSON Schema/);
  assert.match(turns[0].prompt, /"quote": "string\|null"/, 'the shape sketch is in the prompt');
});

test('an answer off the schema gets one corrective turn; still off, a 422 schema_mismatch with the raw text', async () => {
  let calls = 0;
  const fixed = setup({ turn: async () => (++calls === 1 ? answer('{"quote":"x","extra":1}') : answer('{"quote":"x"}', 0.02)) });
  const done = await fixed.run(jsonBody('r1'));
  assert.deepEqual(done.body.data, { quote: 'x' });
  assert.equal(done.body.costUsd, 0.03, 'both turns are counted');
  assert.match(fixed.turns[1].prompt, /\$\.extra: 스키마에 없는 키다/, 'the retry says what was wrong');

  const broken = setup({ turn: async () => answer('I cannot do that') });
  const failed = await broken.run(jsonBody('r2'));
  assert.equal(failed.status, 422);
  const error = failed.body.error as Record<string, unknown>;
  assert.deepEqual([failed.body.ok, failed.body.status, error.code, error.text], [false, 'error', 'schema_mismatch', 'I cannot do that']);
  assert.ok(Array.isArray(error.details));
  assert.equal(broken.turns.length, 2);
});

test('idempotency: the same body returns the stored answer free; another body is a 409', async () => {
  const { service, run, turns } = setup();
  await run(textBody('same'));
  const again = service.submit(textBody('same'));
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.text, again.body.costUsd, again.body.cached], ['hello', 0, true]);
  assert.equal(turns.length, 1, 'the model was not called again');
  const clash = service.submit(textBody('same', 'another task'));
  assert.equal(clash.status, 409);
  assert.equal((clash.body.error as Record<string, unknown>).code, 'conflict');
  // key order does not change the fingerprint; the requestId is not part of it
  assert.equal(requestFingerprint({ requestId: 'a', task: { prompt: 'p', system: 's' } }), requestFingerprint({ task: { system: 's', prompt: 'p' }, requestId: 'b' }));
  assert.notEqual(requestFingerprint({ task: { system: 's', prompt: 'p' } }), requestFingerprint({ task: { system: 's', prompt: 'q' } }), 'a nested change changes it');
});

test('a running request asked again is the same job; a failure is not kept and runs again', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fail = true;
  const { service, settle, turns } = setup({ turn: async () => { await gate; if (fail) return { ok: false, failure: { status: 502, code: 'upstream_error', message: 'boom' } }; return answer('ok'); } });
  const first = service.submit(textBody('dup'));
  const second = service.submit(textBody('dup'));
  assert.deepEqual([second.status, second.body.jobId], [202, first.body.jobId], 'no second job');
  release();
  const failed = await settle(String(first.body.jobId));
  assert.deepEqual([failed.status, (failed.body.error as Record<string, unknown>).code], [502, 'upstream_error']);
  fail = false;
  const retried = service.submit(textBody('dup'));
  assert.equal(retried.status, 202);
  assert.notEqual(retried.body.jobId, first.body.jobId);
  assert.equal((await settle(String(retried.body.jobId))).body.text, 'ok');
  assert.equal(turns.length, 2);
});

test('requests the engine cannot serve are refused at once, before any job', () => {
  const { service, turns } = setup();
  const code = (body: unknown) => { const r = service.submit(body); return [r.status, (r.body.error as Record<string, unknown>)?.code]; };
  assert.deepEqual(code({ task: { system: 's', prompt: 'p' } }), [400, 'bad_request'], 'no requestId');
  assert.deepEqual(code({ requestId: 'x', task: { prompt: 'p' } }), [400, 'bad_request'], 'no system');
  assert.deepEqual(code({ requestId: 'x', task: { system: 's', prompt: 'p' }, output: { format: 'xml' } }), [400, 'bad_request']);
  assert.deepEqual(code({ requestId: 'x', task: { system: 's', prompt: 'p' }, output: { format: 'json' } }), [400, 'bad_request'], 'json without a schema');
  assert.deepEqual(code(jsonBody('x', { output: { format: 'json', schema: { type: 'object', patternProperties: {} } } })), [422, 'schema_unsupported']);
  assert.deepEqual(code(jsonBody('x', { inputs: [{ name: 'a.bin', mime: 'application/x-not-real', base64: 'AAEC' }] })), [415, 'unsupported_media']);
  assert.deepEqual(code(jsonBody('x', { inputs: [{ name: 'a.pdf', mime: 'application/pdf', base64: Buffer.from('not a pdf').toString('base64') }] })), [415, 'unsupported_media']);
  assert.deepEqual(code(jsonBody('x', { inputs: [{ name: 'a.pdf', mime: 'application/pdf', base64: '%%%%' }] })), [400, 'bad_request'], 'not base64');
  assert.deepEqual(code(jsonBody('x', { inputs: [{ name: 'a.pdf', mime: 'application/pdf', base64: pdfBase64 }, { name: 'b.pdf', mime: 'application/pdf', base64: pdfBase64 }] })), [413, 'too_large'], 'one input per request');
  const bigImage = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  assert.deepEqual(code(jsonBody('x', { inputs: [{ name: 'a.png', mime: 'image/png', base64: bigImage }] })), [413, 'too_large']);
  assert.equal(turns.length, 0);
});

test('the input reaches the model turn decoded, and the job keeps no copy of the request body', async () => {
  const { run, turns } = setup({ turn: async () => answer('{"quote":"x"}') });
  await run(jsonBody('in1', { inputs: [{ name: 'drawing.pdf', mime: 'application/pdf', base64: pdfBase64 }] }));
  assert.equal(turns[0].input?.mime, 'application/pdf');
  assert.equal(turns[0].input?.name, 'drawing.pdf');
  assert.equal(turns[0].input?.bytes.toString('base64'), pdfBase64);
});

test('one analysis at a time per account; past the queue the caller is asked to come back', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let most = 0;
  const { service, settle } = setup({ maxQueued: 2, turn: async () => { most = Math.max(most, ++active); await gate; active--; return answer('ok'); } });
  const accepted = ['q1', 'q2', 'q3'].map((id) => service.submit(textBody(id)));
  assert.ok(accepted.every((r) => r.status === 202));
  const refused = service.submit(textBody('q4'));
  assert.deepEqual([refused.status, (refused.body.error as Record<string, unknown>).code], [429, 'rate_limited']);
  release();
  for (const r of accepted) assert.equal((await settle(String(r.body.jobId))).body.text, 'ok');
  assert.equal(most, 1, 'never two model turns at once');
});

test('a job cut by a runtime restart reads as interrupted and its requestId runs again', async () => {
  const db = new Database(':memory:');
  const before = setup({ db, turn: () => new Promise(() => undefined) });
  const started = before.service.submit(textBody('cut'));
  const after = setup({ db });
  const polled = after.service.poll(String(started.body.jobId));
  assert.deepEqual([polled.status, (polled.body.error as Record<string, unknown>).code], [502, 'upstream_error']);
  const again = await after.run(textBody('cut'));
  assert.equal(again.body.text, 'hello');
});

test('the account settings refusing the analysis fail the job with their own status', async () => {
  const { run, turns } = setup({ pick: async () => ({ ok: false, failure: { status: 403, code: 'forbidden', message: 'Claude 사용이 꺼져 있다' } }) });
  const failed = await run(textBody('p1'));
  assert.deepEqual([failed.status, (failed.body.error as Record<string, unknown>).code], [403, 'forbidden']);
  assert.equal(turns.length, 0);
});
