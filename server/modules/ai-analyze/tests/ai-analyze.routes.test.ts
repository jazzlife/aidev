import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createAiAnalyzeRouter } from '@/modules/ai-analyze/ai-analyze.routes.js';
import { classifyTurnFailure } from '@/modules/ai-analyze/claude-analysis.js';

test('the routes pass the service reply through, and keep the contract envelope on errors and unknown paths', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ai-analyze', createAiAnalyzeRouter({ service: {
    submit: (body) => ({ status: 202, body: { ok: true, jobId: 'job_0123456789abcdef', echo: (body as { requestId?: string }).requestId } }),
    poll: (jobId) => { if (jobId === 'job_throws') throw new Error('db gone'); return { status: 200, body: { ok: true, status: 'running' } }; },
  } }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai-analyze`;
    const posted = await fetch(`${base}/v1/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r' }) });
    assert.deepEqual([posted.status, await posted.json()], [202, { ok: true, jobId: 'job_0123456789abcdef', echo: 'r' }]);
    const polled = await fetch(`${base}/v1/analyze/job_x`);
    assert.deepEqual(await polled.json(), { ok: true, status: 'running' });
    const broken = await fetch(`${base}/v1/analyze/job_throws`);
    assert.equal(broken.status, 502);
    assert.equal(((await broken.json()) as { error: { code: string } }).error.code, 'upstream_error');
    const unknown = await fetch(`${base}/v2/analyze`);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'not_found');
  } finally { server.close(); }
});

test('a failed model turn maps to the contract code the caller acts on', () => {
  assert.equal(classifyTurnFailure('', null, null, true).code, 'timeout');
  const limited = classifyTurnFailure('x', null, { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 120 }, false);
  assert.deepEqual([limited.status, limited.code], [429, 'rate_limited']);
  assert.ok((limited.retryAfterSec ?? 0) > 60 && (limited.retryAfterSec ?? 0) <= 120);
  assert.equal(classifyTurnFailure('Invalid API key · Please run /login', null, null, false).message.includes('Claude 로그인'), true);
  assert.equal(classifyTurnFailure('prompt is too long: 250000 tokens > 200000 maximum', 400, null, false).code, 'too_large');
  assert.equal(classifyTurnFailure('Could not process PDF', 400, null, false).code, 'unsupported_media');
  assert.equal(classifyTurnFailure('socket hang up', 500, null, false).code, 'upstream_error');
});
