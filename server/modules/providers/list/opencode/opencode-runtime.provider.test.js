import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  opencodeRuntime,
  readOpenCodeStepTokens,
  resolveOpenCodePermissionOptions,
} from './opencode-runtime.provider.js';
import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';

// The runtime records usage-limit refusals and reads OpenCode's session database under the home directory: every
// case in this file runs against a throwaway one, so nothing lands in (or is read from) the developer's own home.
const testHome = await mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-home-'));
os.homedir = () => testHome;
test.after(() => rm(testHome, { recursive: true, force: true }));

const sessionsProvider = new OpenCodeSessionsProvider();
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId || null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || undefined,
  getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeOpenCodeExecutable(binDir) {
  const scriptPath = path.join(binDir, 'opencode.js');
  await writeFile(scriptPath, `
const capturePath = process.env.OPENCODE_ARGS_CAPTURE;
if (capturePath) {
  require('node:fs').writeFileSync(capturePath, JSON.stringify({
    args: process.argv.slice(2),
    permissionEnv: process.env.OPENCODE_PERMISSION ?? null,
    configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null,
  }));
}

// the event shapes of opencode 1.19.0 (\`run --format json\`): the payload is wrapped in \`part\`, a failure is a
// top-level \`error\` object and the process exits 1
const sessionID = 'open-live-1';
const events = process.env.OPENCODE_FAKE_SCENARIO === 'limit' ? [
  { type: 'error', timestamp: 1, sessionID, error: { name: 'APIError', data: { message: 'You have reached your usage limit for this window.', statusCode: 429, isRetryable: false } } },
] : process.env.OPENCODE_FAKE_SCENARIO === 'bad-key' ? [
  { type: 'error', timestamp: 1, sessionID, error: { name: 'APIError', data: { message: 'Upstream request failed: Invalid credential', statusCode: 401, isRetryable: false } } },
] : [
  { type: 'step_start', timestamp: 1, sessionID, part: { id: 'prt_1', messageID: 'msg_1', sessionID, type: 'step-start' } },
  { type: 'tool_use', timestamp: 2, sessionID, part: { type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed', input: { filePath: '/work/a.txt' }, output: 'file body' }, id: 'prt_2', sessionID, messageID: 'msg_1' } },
  { type: 'text', timestamp: 3, sessionID, part: { id: 'prt_3', messageID: 'msg_1', sessionID, type: 'text', text: 'assistant response' } },
  { type: 'step_finish', timestamp: 4, sessionID, part: { id: 'prt_4', reason: 'stop', messageID: 'msg_1', sessionID, type: 'step-finish', tokens: { total: 7785, input: 103, output: 2, reasoning: 5, cache: { write: 0, read: 7680 } }, cost: 0 } },
];
if (process.env.OPENCODE_FAKE_SCENARIO) process.exitCode = 1;

for (const event of events) {
  console.log(JSON.stringify(event));
}
`, 'utf8');

  if (process.platform === 'win32') {
    const commandPath = path.join(binDir, 'opencode.cmd');
    await writeFile(commandPath, '@echo off\r\nnode "%~dp0opencode.js" %*\r\n', 'utf8');
    return;
  }

  const commandPath = path.join(binDir, 'opencode');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/opencode.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

test('spawnOpenCode emits session_created before normalized live messages for new sessions', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-live-'));
  const argsCapturePath = path.join(tempRoot, 'opencode-args.json');
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const messages = [];
  const writer = {
    userId: null,
    sessionId: null,
    send(message) {
      messages.push(message);
    },
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    await opencodeRuntime.run('Hi', { cwd: tempRoot }, writer, runtimeContext);

    const sessionCreatedIndex = messages.findIndex((message) => message.kind === 'session_created');
    const assistantDeltaIndex = messages.findIndex((message) =>
      message.kind === 'stream_delta' && message.content === 'assistant response',
    );
    const streamEnd = messages.find((message) => message.kind === 'stream_end');
    const complete = messages.find((message) => message.kind === 'complete');

    assert.notEqual(sessionCreatedIndex, -1);
    assert.notEqual(assistantDeltaIndex, -1);
    assert.ok(sessionCreatedIndex < assistantDeltaIndex);
    assert.equal(messages[sessionCreatedIndex].newSessionId, 'open-live-1');
    assert.equal(writer.sessionId, 'open-live-1');
    assert.equal(streamEnd?.sessionId, 'open-live-1');
    assert.equal(complete?.sessionId, 'open-live-1');
    assert.equal(messages.some((message) => message.kind === 'error'), false);
    // a tool call arrives with its input and result (\`part.state\`), and the last step's tokens are the context
    const tool = messages.find((message) => message.kind === 'tool_use');
    assert.deepEqual([tool?.toolName, tool?.toolId, tool?.toolInput, tool?.toolResult], ['read', 'call_1', { filePath: '/work/a.txt' }, { content: 'file body', isError: false }]);
    assert.equal(messages.find((message) => message.text === 'token_budget')?.tokenBudget.used, 7790);
    assert.equal(complete?.usageLimit, undefined);

    const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
    const launchedArgs = capture.args;
    assert.ok(Array.isArray(launchedArgs));
    assert.deepEqual(launchedArgs.slice(0, 4), ['run', '--format', 'json', '--dir']);
    assert.equal(launchedArgs[4], tempRoot);
    // No permission mode requested → no permission flags and no env override.
    assert.equal(launchedArgs.includes('--auto'), false);
    assert.equal(launchedArgs.includes('--agent'), false);
    assert.equal(capture.permissionEnv, null);

    const attachmentOnlyCapturePath = path.join(tempRoot, 'opencode-attachment-only.json');
    process.env.OPENCODE_ARGS_CAPTURE = attachmentOnlyCapturePath;
    await opencodeRuntime.run(
      '',
      {
        cwd: tempRoot,
        files: [{
          path: path.join(tempRoot, 'brief.pdf'),
          name: 'brief.pdf',
          mimeType: 'application/pdf',
        }],
      },
      writer,
      runtimeContext,
    );
    const attachmentOnlyCapture = JSON.parse(await readFile(attachmentOnlyCapturePath, 'utf8'));
    const attachmentPrompt = attachmentOnlyCapture.args[attachmentOnlyCapture.args.length - 1];
    assert.match(attachmentPrompt, /<files_input>/);
    assert.match(attachmentPrompt, /brief\.pdf/);
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveOpenCodePermissionOptions maps UI permission modes onto OpenCode controls', () => {
  assert.deepEqual(resolveOpenCodePermissionOptions('plan'), {
    args: ['--agent', 'plan'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('bypassPermissions'), {
    args: ['--auto'],
    env: {},
  });
  assert.deepEqual(resolveOpenCodePermissionOptions('acceptEdits'), {
    args: [],
    env: { OPENCODE_PERMISSION: '{"edit":"allow"}' },
  });
  // default and anything unknown leave the user's own opencode config in charge.
  assert.deepEqual(resolveOpenCodePermissionOptions('default'), { args: [], env: {} });
  assert.deepEqual(resolveOpenCodePermissionOptions(undefined), { args: [], env: {} });
});

test('spawnOpenCode passes permission mode flags and env to the CLI', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-perms-'));
  const pathKey = findEnvKey('PATH');
  const pathExtKey = findEnvKey('PATHEXT');
  const previousPath = process.env[pathKey];
  const previousPathExt = process.env[pathExtKey];
  const previousArgsCapture = process.env.OPENCODE_ARGS_CAPTURE;
  const writer = {
    userId: null,
    sessionId: null,
    send() {},
    setSessionId(sessionId) {
      this.sessionId = sessionId;
    },
  };

  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    if (process.platform === 'win32') {
      process.env[pathExtKey] = previousPathExt?.toUpperCase().includes('.CMD')
        ? previousPathExt
        : `.COM;.EXE;.BAT;.CMD${previousPathExt ? `;${previousPathExt}` : ''}`;
    }

    const scenarios = [
      {
        permissionMode: 'plan',
        expectArgs: ['--agent', 'plan'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'bypassPermissions',
        expectArgs: ['--auto'],
        expectPermissionEnv: null,
      },
      {
        permissionMode: 'acceptEdits',
        expectArgs: [],
        expectPermissionEnv: '{"edit":"allow"}',
      },
    ];

    for (const scenario of scenarios) {
      const argsCapturePath = path.join(tempRoot, `opencode-args-${scenario.permissionMode}.json`);
      process.env.OPENCODE_ARGS_CAPTURE = argsCapturePath;

      await opencodeRuntime.run(
        'Hi',
        { cwd: tempRoot, permissionMode: scenario.permissionMode },
        writer,
        runtimeContext,
      );

      const capture = JSON.parse(await readFile(argsCapturePath, 'utf8'));
      for (const expectedArg of scenario.expectArgs) {
        assert.ok(
          capture.args.includes(expectedArg),
          `${scenario.permissionMode}: expected "${expectedArg}" in ${JSON.stringify(capture.args)}`,
        );
      }
      // The prompt stays the last positional argument, after any permission flags.
      assert.equal(capture.args[capture.args.length - 1], 'Hi');
      assert.equal(capture.permissionEnv, scenario.expectPermissionEnv);
    }
  } finally {
    if (previousPath === undefined) {
      delete process.env[pathKey];
    } else {
      process.env[pathKey] = previousPath;
    }

    if (previousPathExt === undefined) {
      delete process.env[pathExtKey];
    } else {
      process.env[pathExtKey] = previousPathExt;
    }

    if (previousArgsCapture === undefined) {
      delete process.env.OPENCODE_ARGS_CAPTURE;
    } else {
      process.env.OPENCODE_ARGS_CAPTURE = previousArgsCapture;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('readOpenCodeStepTokens reads a step_finish event\'s tokens as the context in use', () => {
  const event = { type: 'step_finish', part: { tokens: { total: 7785, input: 103, output: 2, reasoning: 5, cache: { write: 10, read: 7680 } } } };
  assert.deepEqual(readOpenCodeStepTokens(event), { used: 7800, inputTokens: 7793, outputTokens: 7, breakdown: { input: 7793, output: 7 } });
  assert.equal(readOpenCodeStepTokens({ type: 'text', part: { text: 'x' } }), null);
  assert.equal(readOpenCodeStepTokens({ type: 'step_finish', part: {} }), null);
});

/** Runs the fake CLI once with the given options and environment; returns what the client saw and how it was launched. */
async function runFakeOpenCode(options, env = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-cli-aidev-'));
  const capturePath = path.join(tempRoot, 'capture.json');
  const pathKey = findEnvKey('PATH');
  const saved = { [pathKey]: process.env[pathKey], OPENCODE_ARGS_CAPTURE: process.env.OPENCODE_ARGS_CAPTURE, OPENCODE_FAKE_SCENARIO: process.env.OPENCODE_FAKE_SCENARIO };
  const messages = [];
  const writer = { userId: null, sessionId: null, send(message) { messages.push(message); }, setSessionId(id) { this.sessionId = id; } };
  try {
    await createFakeOpenCodeExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${saved[pathKey] || ''}`;
    process.env.OPENCODE_ARGS_CAPTURE = capturePath;
    Object.assign(process.env, env);
    const error = await opencodeRuntime.run('Hi', { cwd: tempRoot, ...options }, writer, runtimeContext).then(() => null, (failure) => failure);
    return { messages, error, capture: JSON.parse(await readFile(capturePath, 'utf8')) };
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const aidev = { runId: 12, agent: { name: 'frontend-react', version: 3, description: 'React specialist', prompt: 'You are the React specialist of this platform.', maxTurns: 30 }, lessons: ['Run the type check before reporting.'], engine: 'opencode' };

test('a routed OpenCode run selects the specialist as an agent and carries its instructions in OPENCODE_CONFIG_CONTENT', { skip: process.platform === 'win32' }, async () => {
  const { capture, error } = await runFakeOpenCode({ aidev, permissionMode: 'acceptEdits' });
  assert.equal(error, null);
  assert.equal(capture.args[capture.args.indexOf('--agent') + 1], 'aidev-frontend-react');
  const config = JSON.parse(capture.configContent);
  const agent = config.agent['aidev-frontend-react'];
  assert.equal(agent.mode, 'primary'); assert.equal(agent.steps, 30);
  assert.match(agent.prompt, /You are the React specialist of this platform\./);
  assert.match(agent.prompt, /Run the type check before reporting\./, 'lessons are part of the instructions');
  // acceptEdits still rides in its own variable, next to the aidev config
  assert.equal(capture.permissionEnv, JSON.stringify({ edit: 'allow' }));
});

test('plan mode keeps OpenCode\'s read-only plan agent: the specialist is not selected', { skip: process.platform === 'win32' }, async () => {
  const { capture } = await runFakeOpenCode({ aidev, permissionMode: 'plan' });
  assert.deepEqual(capture.args.filter((arg, index) => capture.args[index - 1] === '--agent'), ['plan']);
  assert.equal(capture.configContent, null, 'no platform runtime here and no agent: nothing to inject');
});

test('an unrouted run is launched as before', { skip: process.platform === 'win32' }, async () => {
  const { capture } = await runFakeOpenCode({});
  assert.equal(capture.args.includes('--agent'), false);
  assert.equal(capture.configContent, null);
});

test('a usage-limit refusal ends the run with usageLimit on its complete, for the apps to hand the work on', { skip: process.platform === 'win32' }, async () => {
  const { messages, error } = await runFakeOpenCode({}, { OPENCODE_FAKE_SCENARIO: 'limit' });
  assert.ok(error, 'the run rejects');
  const complete = messages.find((message) => message.kind === 'complete');
  assert.deepEqual([complete.exitCode, complete.usageLimit], [1, { type: 'unknown', resetsAt: null }]);
  assert.match(messages.find((message) => message.kind === 'error').content, /usage limit.*HTTP 429/);
});

test('a rejected key is an ordinary failure for the run and marks the sign-in as not working', { skip: process.platform === 'win32' }, async () => {
  const { messages } = await runFakeOpenCode({}, { OPENCODE_FAKE_SCENARIO: 'bad-key' });
  const complete = messages.find((message) => message.kind === 'complete');
  assert.equal(complete.usageLimit, undefined);
  assert.match(messages.find((message) => message.kind === 'error').content, /Invalid credential \(HTTP 401\)/);
  const { currentOpenCodeAuthFailure, clearOpenCodeAuthFailure } = await import('@/shared/utils.js');
  assert.match(currentOpenCodeAuthFailure()?.message ?? '', /Invalid credential/);
  clearOpenCodeAuthFailure();
});
