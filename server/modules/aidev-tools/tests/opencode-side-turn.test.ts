import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { askOpenCodeSideTurn } from '@/modules/aidev-tools/opencode-side-turn.client.js';
import { clearOpenCodeAuthFailure, currentOpenCodeAuthFailure } from '@/shared/utils.js';

/**
 * The OpenCode side turn against a stand-in for the CLI: events in the shape opencode 1.19.0 prints
 * (`{type, sessionID, part}` per line), the message read from stdin, and the session deleted afterwards.
 */
type Call = { args: string[]; stdin: string };
function fakeOpenCode(lines: unknown[], exitCode = 0): { spawnFn: typeof spawn; calls: Call[] } {
  const calls: Call[] = [];
  const spawnFn = ((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean; unref: () => void };
    const call: Call = { args, stdin: '' };
    calls.push(call);
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => true; child.unref = () => undefined;
    if (args[0] === 'run') {
      child.stdin.on('data', (chunk: Buffer) => { call.stdin += chunk.toString(); });
      // the CLI answers once the message is in (stdin closed)
      child.stdin.on('end', () => {
        for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
        child.stdout.end();
        setImmediate(() => child.emit('close', exitCode));
      });
    }
    return child;
  }) as unknown as typeof spawn;
  return { spawnFn, calls };
}
const turn = { label: 'verify', instructions: '검증 규칙', prompt: '보고를 확인하라', cwd: '/tmp/project', model: 'opencode-go/glm-5.3', effort: 'high', timeoutMs: 5_000 };

test('a check turn: every permission, the model and variant, the message on stdin, the text parts joined, the session deleted', async () => {
  const { spawnFn, calls } = fakeOpenCode([
    { type: 'step_start', sessionID: 'ses_1', part: {} },
    { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'bash', state: { status: 'completed', output: 'ok' } } },
    { type: 'text', sessionID: 'ses_1', part: { text: '확인했습니다.' } },
    { type: 'text', sessionID: 'ses_1', part: { text: '<aidev-verify>{"verdict":"pass"}</aidev-verify>' } },
    { type: 'step_finish', sessionID: 'ses_1', part: { reason: 'stop' } },
  ]);
  const text = await askOpenCodeSideTurn({ ...turn, access: 'check' }, spawnFn);
  assert.equal(text, '확인했습니다.\n<aidev-verify>{"verdict":"pass"}</aidev-verify>');
  assert.deepEqual(calls[0].args, ['run', '--format', 'json', '--dir', '/tmp/project', '--title', 'aidev-side: verify', '--model', 'opencode-go/glm-5.3', '--variant', 'high', '--auto']);
  assert.equal(calls[0].stdin, '검증 규칙\n\n---\n\n보고를 확인하라');
  assert.deepEqual(calls[1].args, ['session', 'delete', 'ses_1'], 'the side turn never stays in OpenCode\'s session list');
});

test('a read turn runs under OpenCode\'s plan agent on the model it starts on', async () => {
  const { spawnFn, calls } = fakeOpenCode([{ type: 'text', sessionID: 'ses_2', part: { text: '{"none":true}' } }]);
  await askOpenCodeSideTurn({ ...turn, label: 'curate', model: null, effort: null, access: 'read' }, spawnFn);
  assert.deepEqual(calls[0].args, ['run', '--format', 'json', '--dir', '/tmp/project', '--title', 'aidev-side: curate', '--agent', 'plan']);
  // the plan agent's own reminder is named for what it is, so the answer is about the task
  assert.match(calls[0].stdin, /^\(실행 환경 안내: .*Plan Mode·READ-ONLY 안내문은.*\)\n\n검증 규칙\n\n---\n\n보고를 확인하라$/s);
});

test('an error event fails the turn; a rejected sign-in is noted for the auth probe, and the session is still deleted', async () => {
  clearOpenCodeAuthFailure();
  const limit = fakeOpenCode([{ type: 'error', sessionID: 'ses_3', error: { name: 'APIError', data: { message: 'You have no credits remaining', statusCode: 429 } } }], 1);
  await assert.rejects(askOpenCodeSideTurn({ ...turn, access: 'check' }, limit.spawnFn), /no credits remaining \(HTTP 429\)/);
  assert.deepEqual(limit.calls[1].args, ['session', 'delete', 'ses_3']);
  assert.equal(currentOpenCodeAuthFailure(), null, 'a usage limit is not a sign-in failure');
  const auth = fakeOpenCode([{ type: 'error', sessionID: 'ses_4', error: { name: 'APIError', data: { message: 'Invalid API key', statusCode: 401 } } }], 1);
  await assert.rejects(askOpenCodeSideTurn({ ...turn, access: 'read' }, auth.spawnFn), /Invalid API key/);
  assert.match(currentOpenCodeAuthFailure()?.message ?? '', /Invalid API key/);
  clearOpenCodeAuthFailure();
});

test('no answer at all is a failure, not an empty verdict', async () => {
  const { spawnFn } = fakeOpenCode([{ type: 'step_start', sessionID: 'ses_5', part: {} }], 0);
  await assert.rejects(askOpenCodeSideTurn({ ...turn, access: 'read' }, spawnFn), /gave no answer/);
});
