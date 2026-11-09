import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { aidevApi, type CreateQueueEntry, type RouteResult } from '@/modules/aidev-router/api';
import { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
import { useCreateProposals } from '@/modules/aidev-router/hooks/useCreateProposals';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * 2026-11-09: a missing specialist is designed by the gateway out of band, never as a turn of the chat — reading the
 * design back from the chat lost it to an interruption, another chat's end or a mistyped closing tag. The send runs on
 * the routed agent unchanged, and a create-queue proposal's "만들기" asks the gateway to design without a chat turn.
 */
const createRoute = {
  decision_id: 9, decision: 'create_background', fallback: false, laya_error: null,
  create: { architect: { name: 'agent-architect', version: 1, description: 'architect', prompt: 'design', tools: null, maxTurns: 20, model: null }, catalog: '', background: true, design: true,
    proposal: { name: 'sidecar-bridge', domain: 'display protocols', description: 'Sidecar', technologies: ['AirPlay'] }, queue: null, from_queue: false },
  scope: { depth: 2, task_kind: 'design', risk: 0, remote_action: 'none', ask_clarify: false, clarify_question: null },
  agent: { id: 1, name: 'generalist', version: 1, domain: 'meta', description: '', probability: 1, confidence: 1, definition: { prompt: 'general help', tools: null, model: null, maxTurns: null, skills: null, mcpServers: null } },
  alternatives: [], needs_new: 0, plan: { engine: 'claude', engine_locked: false, model: 'opus', effort: 'high', target: null, reason: [] },
  engines: { claude: { allowed: true, authenticated: true, score: 0.5, notes: [] }, codex: { allowed: false, authenticated: false, score: null, notes: [] } },
  lessons: [], knowledge_digest: null, latency_ms: 1, total_ms: 1, device: 'mock',
} as unknown as RouteResult;

beforeEach(() => {
  vi.restoreAllMocks();
  routingStore.patch({ mode: 'auto', oneShotAgent: null, oneShotPlan: null, overrides: {} });
  vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 5 });
});

describe('agent creation never takes a chat turn', () => {
  it('a send without a fitting specialist runs on the routed agent while the gateway designs one', async () => {
    vi.spyOn(aidevApi, 'route').mockResolvedValue(createRoute);
    const { result } = renderHook(() => useAidevRouting());
    let decoration: Awaited<ReturnType<typeof result.current.beforeSend>> = null;
    await act(async () => { decoration = await result.current.beforeSend('mac의 sidecar 프로토콜을 윈도우와 통신하게 할 수 있어?', { sessionId: null, provider: 'claude', isNewSession: true, userPinnedModel: false }); });
    expect((decoration!.aidev.agent as { name: string }).name).toBe('generalist');
    expect(decoration!.appResend).toBe(false);
  });

  it('"만들기" on a proposal asks the gateway to design it and leaves the list; a failure brings it back', async () => {
    const entry = { id: 42, name: 'unity-shader', domain: 'Unity graphics', description: 'Unity', technologies: ['Unity'], count: 3, status: 'proposed', commands: ['셰이더 색 바꿔줘'] } as unknown as CreateQueueEntry;
    const listSpy = vi.spyOn(aidevApi, 'createQueue').mockResolvedValue({ entries: [entry] });
    const designSpy = vi.spyOn(aidevApi, 'designCreate').mockResolvedValue({ designing: true });
    const { result } = renderHook(() => useCreateProposals());
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));
    act(() => { result.current.accept(entry); });
    expect(designSpy).toHaveBeenCalledWith(42);
    expect(result.current.proposals).toHaveLength(0);
    designSpy.mockRejectedValueOnce(new Error('offline'));
    act(() => { result.current.accept(entry); });
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
  });
});
