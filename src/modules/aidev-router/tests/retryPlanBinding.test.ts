import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { aidevApi, type RouteResult } from '@/modules/aidev-router/api';
import { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * A verifier's retry plan (opus/xhigh at D4) belongs to the retry's own command. Server run #398 (2026-10-18): the retry
 * never went out, and the user's next "진행해" — judged D1 — ran on that plan and its agent.
 */
const route = {
  decision_id: 3, decision: 'use', fallback: false, laya_error: null, create: null,
  scope: { depth: 1, task_kind: 'ops', risk: 0, remote_action: 'none', ask_clarify: false, clarify_question: null },
  agent: { id: 1, name: 'generalist', version: 1, domain: 'meta', description: '', probability: 1, confidence: 1, definition: { prompt: '', tools: null, model: null, maxTurns: null, skills: null, mcpServers: null } },
  alternatives: [], needs_new: 0, plan: { engine: 'claude', engine_locked: true, model: 'opus', effort: 'medium', target: null, reason: [] },
  engines: { claude: { allowed: true, authenticated: true, score: 0.5, notes: [] } },
  lessons: [], knowledge_digest: null, latency_ms: 1, total_ms: 1, device: 'mock',
} as unknown as RouteResult;
const context = { sessionId: 's1', provider: 'claude', isNewSession: false, userPinnedModel: false };
const retryText = '재생/정지 상태도 연동되게 해\n\n[검증에서 발견된 문제 — 먼저 해결할 것]\n- 연동 구현이 없음';

beforeEach(() => {
  routingStore.patch({ mode: 'auto', oneShotAgent: 'game-loop-player', oneShotCreate: null, overrides: {}, overridesSessionId: 's1',
    oneShotPlan: { engine: 'claude', model: 'opus', effort: 'xhigh', depth: 4, escalatedFromRun: 397, forText: retryText } });
  vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 5 });
});

describe('a retry plan is bound to its command', () => {
  it('another command sent first is routed as itself, and the plan is gone', async () => {
    const routeSpy = vi.spyOn(aidevApi, 'route').mockResolvedValue(route);
    const runSpy = vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 6 });
    const { result } = renderHook(() => useAidevRouting());
    await act(async () => { await result.current.beforeSend('진행해', context); });
    expect(routeSpy.mock.calls[0][0]).toMatchObject({ model: null, effort: null, forceAgent: null });
    expect(runSpy.mock.calls[0][0]).toMatchObject({ depth: 1 });
    expect(runSpy.mock.calls[0][0]).not.toHaveProperty('escalated_from_run');
    expect(routingStore.get().oneShotPlan).toBeNull();
    expect(routingStore.get().oneShotAgent).toBeNull();
  });

  it('the retry itself (after a draft the composer kept) runs on the plan', async () => {
    const routeSpy = vi.spyOn(aidevApi, 'route').mockResolvedValue(route);
    const runSpy = vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 7 });
    const { result } = renderHook(() => useAidevRouting());
    await act(async () => { await result.current.beforeSend(`쓰던 초안 ${retryText}`, context); });
    expect(routeSpy.mock.calls[0][0]).toMatchObject({ model: 'opus', effort: 'xhigh', forceAgent: 'game-loop-player' });
    expect(runSpy.mock.calls[0][0]).toMatchObject({ depth: 4, escalated_from_run: 397 });
  });
});
