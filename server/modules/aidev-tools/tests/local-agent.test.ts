import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { localAgentCommand, localAgentPrompt, parseLocalAgentOutput, pickLocalAgent } from '@/modules/aidev-tools/local-agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('local agent (F-09d): picks an installed CLI and builds its headless command (task on stdin)', () => {
  assert.equal(pickLocalAgent(undefined, { codex: 'codex-cli 0.159.2', claude: '2.1.285 (Claude Code)' }), 'claude');
  assert.equal(pickLocalAgent('auto', { gemini: '0.62.0' }), 'gemini');
  assert.equal(pickLocalAgent('codex', {}), 'codex');
  assert.equal(pickLocalAgent('cursor', { claude: 'x' }), null);
  assert.equal(pickLocalAgent(undefined, null), null);
  assert.equal(localAgentCommand('claude', 'full'), 'claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Bash');
  assert.equal(localAgentCommand('claude', 'readonly', { resume: '5d0c7a4e-1111-4222-8333-944455556666', model: 'sonnet' }), 'claude -p --output-format stream-json --verbose --permission-mode plan --model sonnet --resume 5d0c7a4e-1111-4222-8333-944455556666');
  assert.equal(localAgentCommand('codex', 'full'), 'codex exec --json --skip-git-repo-check --sandbox danger-full-access -');
  assert.equal(localAgentCommand('codex', 'readonly', { resume: '01a0f2ca-ccfb-7b72-b053-05dd9c003ba1' }), 'codex exec --json --skip-git-repo-check --sandbox read-only resume 01a0f2ca-ccfb-7b72-b053-05dd9c003ba1 -');
  assert.equal(localAgentCommand('gemini', 'full'), 'gemini -p "Do the task described above." --output-format json --skip-trust --approval-mode yolo');
  assert.throws(() => localAgentCommand('gemini', 'full', { resume: 'abcdef' }), /resume/);
  assert.throws(() => localAgentCommand('claude', 'full', { resume: 'x; rm -rf /' }), /resume/);
  assert.throws(() => localAgentCommand('claude', 'full', { model: 'a b' }), /model/);
  const p = localAgentPrompt('iOS 시뮬레이터에서 로그인 화면이 멈추는 원인을 찾아 고쳐라', { machine: 'm4pro', platform: 'macos', cwd: '~/aidev-work/app', mode: 'full', resume: false });
  assert.match(p, /m4pro/); assert.match(p, /작업 폴더: ~\/aidev-work\/app/); assert.match(p, /로그인 화면/); assert.match(p, /보고하라/);
  assert.equal(localAgentPrompt('계속', { machine: 'm', platform: null, cwd: null, mode: 'full', resume: true }), '계속');
});

test('local agent: parses a real Claude Code stream-json run (tool steps, result, session, cost)', () => {
  const r = parseLocalAgentOutput(fs.readFileSync(path.join(here, 'fixtures-claude-stream.jsonl'), 'utf8'));
  assert.equal(r.agent, 'claude');
  assert.equal(r.sessionId, '5d0c7a4e-1111-4222-8333-944455556666');
  assert.match(r.result ?? '', /a-b/);
  assert.equal(r.isError, false);
  assert.deepEqual(r.steps, ['Read: /w/p/calc.c']);
  assert.equal(r.turns, 2);
  assert.ok((r.costUsd ?? 0) > 0);
  // a tail that lost its first line and has no result yet: the last text is the result so far
  const partial = parseLocalAgentOutput('ng"}]}}\n{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"xcodebuild test -scheme App"}}]},"session_id":"s-123456"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"빌드 중"}]}}\n');
  assert.deepEqual([partial.agent, partial.sessionId, partial.result, partial.steps], ['claude', 's-123456', '빌드 중', ['Bash: xcodebuild test -scheme App']]);
  const failed = parseLocalAgentOutput('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s-9"}');
  assert.equal(failed.isError, true); assert.equal(failed.error, 'error_max_turns');
});

test('local agent: parses Codex exec --json (commands, file changes, transient errors) and Gemini json', () => {
  const codex = [
    '{"type":"thread.started","thread_id":"01a0f2ca-ccfb-7b72-b053-05dd9c003ba1"}',
    '{"type":"turn.started"}',
    '{"type":"error","message":"Reconnecting... 2/5 (stream disconnected)"}',
    '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc \'dotnet test\'","aggregated_output":"Failed: 1","exit_code":1,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/Calc.cs","kind":"update"}],"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"원인: Add가 뺄셈. 고친 뒤 dotnet test 통과."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
  ].join('\n');
  const c = parseLocalAgentOutput(codex);
  assert.equal(c.agent, 'codex'); assert.equal(c.sessionId, '01a0f2ca-ccfb-7b72-b053-05dd9c003ba1');
  assert.equal(c.isError, false); assert.match(c.result ?? '', /통과/);
  assert.deepEqual(c.steps, ["$ bash -lc 'dotnet test' (exit 1)", '파일 변경: src/Calc.cs']);
  const down = parseLocalAgentOutput('{"type":"thread.started","thread_id":"t-1234"}\n{"type":"error","message":"stream disconnected: 403"}\n');
  assert.equal(down.isError, true); assert.match(down.error ?? '', /403/);
  const gem = parseLocalAgentOutput('Approval mode overridden\n{\n  "session_id": "a44b",\n  "response": "원인은 null 체크 누락",\n  "stats": {}\n}\n', 'gemini');
  assert.equal(gem.agent, 'gemini'); assert.equal(gem.result, '원인은 null 체크 누락');
  const gerr = parseLocalAgentOutput('{\n  "session_id": "a44b",\n  "error": { "type": "Error", "message": "Please set an Auth method", "code": 41 }\n}\n', 'gemini');
  assert.equal(gerr.isError, true); assert.match(gerr.error ?? '', /Auth/);
});
