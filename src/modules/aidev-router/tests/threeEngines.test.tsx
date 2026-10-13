import assert from 'node:assert/strict';

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import { aidevApi, type EnginesResult, type RouteResult } from '@/modules/aidev-router/api';
import { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
import { nextUsableEngine } from '@/modules/aidev-router/hooks/useEscalation';
import { ProviderPolicyCard } from '@/modules/aidev-router/ProviderPolicySettings';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * OpenCode as the third engine (PROVIDER-ENGINE-PLAN G4): a usage limit hands the chat to the next provider of the work
 * order, a chat on an engine the account does not route to is sent unrouted, and OpenCode's range card works on the
 * account's own models (no tier table).
 */
const usable = { allowed: true, authenticated: true, score: 0.5, notes: [] };
const engines = (over: Partial<EnginesResult['engines']>, priority: EnginesResult['engine_priority'] = []) => ({ engines: { claude: usable, codex: usable, opencode: usable, ...over }, engine_priority: priority });

test('nextUsableEngine: the work order first, then the rest; never the blocked, signed-out, disallowed or limited one', () => {
  assert.equal(nextUsableEngine('opencode', engines({}, ['opencode', 'codex', 'claude'])), 'codex');
  assert.equal(nextUsableEngine('claude', engines({})), 'codex', 'no order: the engines as listed');
  assert.equal(nextUsableEngine('claude', engines({ codex: { ...usable, authenticated: false } })), 'opencode');
  assert.equal(nextUsableEngine('claude', engines({ codex: { ...usable, limited_until: 2000 }, opencode: { ...usable, allowed: false } }), 1000), null);
  assert.equal(nextUsableEngine('claude', engines({ codex: { ...usable, limited_until: 2000 }, opencode: { ...usable, allowed: false } }), 3000), 'codex', 'the limit is over');
  assert.equal(nextUsableEngine('claude', { engines: { claude: usable }, engine_priority: [] }), null, 'an older gateway reports fewer engines');
});

const routeFor = (opencodeAllowed: boolean) => ({
  decision_id: 3, decision: 'use', fallback: false, laya_error: null, create: null,
  scope: { depth: 1, task_kind: 'implement', risk: 0, remote_action: 'none', ask_clarify: false, clarify_question: null },
  agent: { id: 1, name: 'generalist', version: 1, domain: 'meta', description: '', probability: 1, confidence: 1, definition: { prompt: '', tools: null, model: null, maxTurns: null, skills: null, mcpServers: null } },
  alternatives: [], needs_new: 0, plan: { engine: opencodeAllowed ? 'opencode' : 'claude', engine_locked: false, model: opencodeAllowed ? 'opencode-go/glm-5.3' : 'sonnet', effort: 'medium', target: null, reason: [] },
  engines: { claude: usable, codex: usable, opencode: { ...usable, allowed: opencodeAllowed } },
  lessons: [], knowledge_digest: null, latency_ms: 1, total_ms: 1, device: 'mock',
}) as unknown as RouteResult;

beforeEach(() => {
  vi.restoreAllMocks();
  routingStore.patch({ mode: 'auto', pendingCreate: null, oneShotAgent: null, oneShotCreate: null, oneShotPlan: null, overrides: {}, runId: null });
});

test('an OpenCode chat is routed like any engine once the account routes to OpenCode', async () => {
  const route = vi.spyOn(aidevApi, 'route').mockResolvedValue(routeFor(true));
  vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 8 });
  const { result } = renderHook(() => useAidevRouting());
  let decoration: Awaited<ReturnType<typeof result.current.beforeSend>> = null;
  await act(async () => { decoration = await result.current.beforeSend('테스트 추가해줘', { sessionId: 'oc-1', provider: 'opencode', isNewSession: false, userPinnedModel: false }); });
  assert.equal(route.mock.calls[0][0].sessionEngine, 'opencode');
  assert.equal(decoration!.route.plan.engine, 'opencode');
  assert.equal(routingStore.get().runId, 8);
});

test('where the account does not route to OpenCode, an OpenCode chat is sent as it is and logs no run', async () => {
  vi.spyOn(aidevApi, 'route').mockResolvedValue(routeFor(false));
  const createRun = vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 9 });
  const { result } = renderHook(() => useAidevRouting());
  let decoration: Awaited<ReturnType<typeof result.current.beforeSend>> | undefined;
  await act(async () => { decoration = await result.current.beforeSend('테스트 추가해줘', { sessionId: null, provider: 'opencode', isNewSession: true, userPinnedModel: false }); });
  assert.equal(decoration, null, 'unrouted: the chat stays on OpenCode instead of becoming a Claude session');
  assert.equal(createRun.mock.calls.length, 0);
  assert.equal(routingStore.get().busy, false);
});

test('OpenCode\'s range card: its own models, the model it starts on until a ladder is set, no tier table', async () => {
  const GLM = 'opencode-go/glm-5.3'; const FREE = 'opencode/big-pickle';
  const entry = {
    allowed: true, mode: 'split', tier_table: false, own_ladder: false, ladder: [GLM], floor: null, ceiling: null, effort_floor: null, effort_cap: 'xhigh',
    effort_ladder: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    preview: ['low', 'low', 'medium', 'high', 'high'].map((effort, depth) => ({ model: GLM, effort, score: null, q2: depth > 2, mode: 'steps' })),
    catalog: [FREE, GLM].map((model) => ({ model, level: 2, efforts: model === GLM ? ['low', 'medium', 'high'] : [], scores: [] })),
  };
  const sent: unknown[] = [];
  vi.spyOn(aidevApi, 'providerPolicy').mockResolvedValue({ providers: { opencode: entry }, work_priority: [], verify_priority: [], score_index: 'coding', scores_source: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai', version: null, synced_at: null } } as never);
  vi.spyOn(aidevApi, 'setProviderPolicy').mockImplementation(async (patch) => { sent.push(patch); return { providers: { opencode: { ...entry, own_ladder: true } }, work_priority: [], verify_priority: [], score_index: 'coding', scores_source: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai', version: null, synced_at: null } } as never; });
  render(<ProviderPolicyCard engine="opencode" />);
  await waitFor(() => screen.getByTestId('provider-policy-opencode'));
  assert.ok(screen.getByText('기본 모델'), 'not "등급표": OpenCode has none');
  assert.match(screen.getByTestId('provider-preview-opencode').textContent ?? '', /D3.*glm-5\.3 · high \(상한·최대\)/);
  assert.equal(screen.queryByLabelText('opencode 기본 모델 하한'), null, 'one model: no floor to pick');
  // "범위 설정" starts the user's own ladder from the model OpenCode starts on; the other models are then offered
  await act(async () => { screen.getByText('범위 설정').click(); });
  assert.deepEqual(sent, [{ engine: 'opencode', ladder: [GLM] }]);
  await waitFor(() => screen.getByText('기본 모델로 되돌리기'));
  assert.ok(screen.getByLabelText(`${FREE} 사용`), 'the account\'s other OpenCode models can join the ladder');
});

test('a provider the account does not route to says so on its range tab', async () => {
  vi.spyOn(aidevApi, 'providerPolicy').mockResolvedValue({ providers: { opencode: { allowed: false, mode: 'tier', tier_table: false, own_ladder: false, ladder: null, floor: null, ceiling: null, effort_floor: null, effort_cap: 'xhigh', effort_ladder: [], preview: [], catalog: [] } }, work_priority: [], verify_priority: [], score_index: 'coding', scores_source: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai', version: null, synced_at: null } } as never);
  render(<ProviderPolicyCard engine="opencode" />);
  await waitFor(() => screen.getByText(/아직 OpenCode\(으\)로 작업을 보내도록 켜져 있지 않습니다/));
  assert.ok(screen.getByText(/OpenCode에 로그인하면 쓸 수 있는 모델이 여기에 나타납니다/));
});
