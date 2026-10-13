import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenCodeAidevConfig, composeAgentInstructions, sanitizeAidevOptions } from '@/modules/aidev-tools/aidev-tools.service.js';

const validTurn = {
  runId: 12,
  agent: {
    name: 'frontend-react',
    version: 3,
    description: 'React specialist',
    prompt: 'You are a React 19 expert. Verify with tsc.',
    tools: ['Read', 'Edit', 'Bash', 'mcp__aidev-tools__aidev_decide', 'bad tool name!'],
    model: 'sonnet',
    maxTurns: 20,
    skills: ['frontend-module-standards', 'Not Valid'],
    mcpServers: { 'my-docs': { command: 'npx', args: ['docs-mcp'], env: { API_KEY: 'x', 'bad-key': 'y' } }, 'remote-docs': { url: 'https://example.com/mcp' }, 'evil': 'string' },
  },
  lessons: ['shader renders black → check pass tags', 42],
  knowledgeDigest: '### URP 17\nUse Blitter.',
  engine: 'claude',
  model: 'sonnet',
  effort: 'high',
  target: { id: 4, name: 'mac-studio', platform: 'macos', tags: ['xcode'], capabilities: { node: '22' } },
  device: { serial: 'R3CN11', tool: 'adb', source: 'laya' },
  scope: { depth: 2, taskKind: 'implement', risk: 1, remoteAction: 'test' },
  extra: 'dropped',
};

test('sanitizeAidevOptions keeps whitelisted fields and drops invalid entries', () => {
  const clean = sanitizeAidevOptions(validTurn);
  assert.ok(clean);
  assert.equal(clean.runId, 12);
  assert.equal(clean.agent.name, 'frontend-react');
  assert.deepEqual(clean.agent.tools, ['Read', 'Edit', 'Bash', 'mcp__aidev-tools__aidev_decide']);
  assert.deepEqual(clean.agent.skills, ['frontend-module-standards']);
  assert.deepEqual(Object.keys(clean.agent.mcpServers ?? {}), ['my-docs', 'remote-docs']);
  assert.deepEqual((clean.agent.mcpServers as Record<string, { env?: Record<string, string> }>)['my-docs'].env, { API_KEY: 'x' });
  assert.deepEqual(clean.lessons, ['shader renders black → check pass tags']);
  assert.equal(clean.target?.name, 'mac-studio');
  assert.equal(clean.scope.remoteAction, 'test');
  assert.deepEqual(clean.device, { serial: 'R3CN11', tool: 'adb' });
  assert.equal(sanitizeAidevOptions({ ...validTurn, device: { serial: 'x; rm -rf /', tool: 'adb' } })?.device, null);
  assert.equal(sanitizeAidevOptions({ ...validTurn, device: { serial: 'A1', tool: 'fastboot' } })?.device, null);
  assert.equal((clean as Record<string, unknown>).extra, undefined);
});

test('sanitizeAidevOptions rejects payloads without a usable agent', () => {
  assert.equal(sanitizeAidevOptions(null), null);
  assert.equal(sanitizeAidevOptions({ agent: { name: 'Bad Name', prompt: 'x'.repeat(30) } }), null);
  assert.equal(sanitizeAidevOptions({ agent: { name: 'ok-name' } }), null);
});

test('sanitizeAidevOptions bounds sizes', () => {
  const clean = sanitizeAidevOptions({ agent: { name: 'big', prompt: 'p'.repeat(50000) }, lessons: Array.from({ length: 40 }, (_, index) => `l${index}`) });
  assert.ok(clean);
  assert.equal(clean.agent.prompt.length, 32000);
  assert.equal(clean.lessons.length, 20);
});

test('composeAgentInstructions includes prompt, lessons, knowledge, target and the decide hint', () => {
  const clean = sanitizeAidevOptions(validTurn);
  assert.ok(clean);
  const text = composeAgentInstructions(clean);
  assert.match(text, /# 전문 agent: frontend-react \(v3\)/);
  assert.match(text, /You are a React 19 expert/);
  assert.match(text, /얻은 교훈[\s\S]*- shader renders black/);
  assert.match(text, /검증된 최신 지식[\s\S]*Blitter/);
  assert.match(text, /원격 실행 대상[\s\S]*mac-studio[\s\S]*요청된 원격 작업: test/);
  assert.match(text, /대상 기기: adb serial `R3CN11`[\s\S]*adb -s R3CN11/);
  assert.match(text, /aidev_decide/);
});

test('buildOpenCodeAidevConfig: the routed agent as an OpenCode agent, its MCP servers in OpenCode\'s shape', () => {
  const { config, agent } = buildOpenCodeAidevConfig({ ...validTurn, engine: 'opencode' });
  assert.equal(agent, 'aidev-frontend-react');
  const entry = (config?.agent as Record<string, Record<string, unknown>>)['aidev-frontend-react'];
  assert.deepEqual([entry.mode, entry.steps], ['primary', 20]);
  assert.match(String(entry.prompt), /You are a React 19 expert/);
  assert.match(String(entry.prompt), /check pass tags/, 'lessons ride in the prompt');
  const mcp = config?.mcp as Record<string, Record<string, unknown>>;
  assert.deepEqual(mcp['my-docs'], { type: 'local', command: ['npx', 'docs-mcp'], environment: { API_KEY: 'x' }, enabled: true });
  assert.deepEqual(mcp['remote-docs'], { type: 'remote', url: 'https://example.com/mcp', enabled: true });
  // outside the platform (AIDEV_RUNTIME unset in tests) the aidev-tools server is not added
  assert.equal(mcp['aidev-tools'], undefined);
  // plan mode keeps OpenCode's plan agent: no custom agent, the agent's MCP servers still come
  const plan = buildOpenCodeAidevConfig({ ...validTurn, engine: 'opencode' }, { planMode: true });
  assert.equal(plan.agent, null); assert.equal(plan.config?.agent, undefined); assert.ok((plan.config?.mcp as Record<string, unknown>)['my-docs']);
  // nothing routed and no platform: nothing to inject
  assert.deepEqual(buildOpenCodeAidevConfig(undefined), { config: null, agent: null });
  // the engine survives sanitising now
  assert.equal(sanitizeAidevOptions({ ...validTurn, engine: 'opencode' })?.engine, 'opencode');
});
