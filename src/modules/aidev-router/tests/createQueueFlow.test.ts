import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { aidevApi, type AgentDraft, type RouteResult } from '@/modules/aidev-router/api';
import { useAgentCreation } from '@/modules/aidev-router/hooks/useAgentCreation';
import { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * D-04: accepting a create-queue proposal arms the next send (createProposal); the architect turn it routes to has
 * nothing to re-send afterwards — the domain's commands already ran — and the created agent closes the queue entry.
 */
const architectRoute = (fromQueue: boolean) => ({
  decision_id: 9, decision: 'create', fallback: false, laya_error: null,
  create: { architect: { name: 'agent-architect', version: 1, description: 'architect', prompt: 'design', tools: null, maxTurns: 6, model: null }, catalog: '', background: false, proposal: { name: 'unity-shader', domain: 'Unity graphics', description: 'Unity', technologies: ['Unity'] },
    queue: fromQueue ? { id: 42, name: 'unity-shader', count: 4, proposed_now: false } : null, from_queue: fromQueue },
  scope: { depth: 1, task_kind: 'implement', risk: 0, remote_action: 'none', ask_clarify: false, clarify_question: null },
  agent: { id: 1, name: 'generalist', version: 1, domain: 'meta', description: '', probability: 1, confidence: 1, definition: { prompt: '', tools: null, model: null, maxTurns: null, skills: null, mcpServers: null } },
  alternatives: [], needs_new: 0, plan: { engine: 'claude', engine_locked: false, model: 'sonnet', effort: 'medium', target: null, reason: [] },
  engines: { claude: { allowed: true, authenticated: true, score: 0.5, notes: [] }, codex: { allowed: false, authenticated: false, score: null, notes: [] } },
  lessons: [], knowledge_digest: null, latency_ms: 1, total_ms: 1, device: 'mock',
}) as unknown as RouteResult;

const draft = { name: 'unity-shader', domain: 'gamedev', hint: 'unity shaders', description: 'Unity shaders', prompt: 'You are…', tools: null, examples: [], knowledge: [], self_check: null } as unknown as AgentDraft;
const context = { sessionId: 's1', provider: 'claude', isNewSession: false, userPinnedModel: false };

beforeEach(() => {
  routingStore.patch({ mode: 'auto', pendingCreate: null, oneShotAgent: null, oneShotCreate: null, oneShotPlan: null, overrides: {} });
  vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 5 });
});

describe('create queue flow (D-04)', () => {
  it('an accepted proposal rides the next route once and the architect turn keeps nothing to re-send', async () => {
    const routeSpy = vi.spyOn(aidevApi, 'route').mockResolvedValue(architectRoute(true));
    routingStore.patch({ oneShotCreate: 42 });
    const { result } = renderHook(() => useAidevRouting());
    let decoration: Awaited<ReturnType<typeof result.current.beforeSend>> = null;
    await act(async () => { decoration = await result.current.beforeSend('[전문 agent 만들기] Unity graphics — Unity', context); });
    expect(routeSpy.mock.calls[0][0].createProposal).toBe(42);
    expect(routingStore.get().oneShotCreate).toBeNull();
    expect(routingStore.get().pendingCreate).toMatchObject({ stage: 'architect', originalText: '', queueId: 42 });
    expect(decoration!.appResend).toBe(true);
  });

  it('approving the draft closes the queue entry and re-sends nothing', async () => {
    const createSpy = vi.spyOn(aidevApi, 'createAgent').mockResolvedValue({ agent: { id: 77, name: 'unity-shader' } } as never);
    routingStore.patch({ pendingCreate: { stage: 'review', originalText: '', queueId: 42, sessionId: 's1', decisionId: 9, draft, agentId: null, agentName: null, selfCheckResult: null, error: null } });
    const resend = vi.fn();
    const { result } = renderHook(() => useAgentCreation({ getLastAssistantText: () => null, resend }));
    await act(async () => { await result.current.approve(draft); });
    expect(createSpy.mock.calls[0][0]).toMatchObject({ queue_id: 42 });
    expect(resend).not.toHaveBeenCalled();
    expect(routingStore.get().oneShotAgent).toBeNull();
  });

  it('an ordinary creation still re-sends the original command with the new agent', async () => {
    vi.spyOn(aidevApi, 'createAgent').mockResolvedValue({ agent: { id: 78, name: 'unity-shader' } } as never);
    routingStore.patch({ pendingCreate: { stage: 'review', originalText: 'Unity 물 셰이더 만들어줘', sessionId: 's1', decisionId: 9, draft, agentId: null, agentName: null, selfCheckResult: null, error: null } });
    const resend = vi.fn();
    const { result } = renderHook(() => useAgentCreation({ getLastAssistantText: () => null, resend }));
    await act(async () => { await result.current.approve(draft); });
    expect(resend).toHaveBeenCalledWith('Unity 물 셰이더 만들어줘');
    expect(routingStore.get().oneShotAgent).toBe('unity-shader');
  });
});
