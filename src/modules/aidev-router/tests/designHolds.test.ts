import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aidevApi, type RouteResult } from '@/modules/aidev-router/api';
import { designHoldFor, GENERALIST, HOLD_MAX_MS, useDesignHolds } from '@/modules/aidev-router/hooks/useDesignHolds';
import { routingStore } from '@/modules/aidev-router/store';
import { readQueuedMessages, resetChatDrafts, writeQueuedMessages } from '@/shared/chatDrafts';

/**
 * Held commands (2026-11-09): the page's one watcher releases a command held for a specialist being designed — routed
 * to that agent once the design is created, to the generalist when it ended without one or took too long — back into
 * its chat's queue as an ordinary turn carrying the routing, for the server to send.
 */
// the draft store's server: keeps what the app saves, so the watcher's reload reads the queues back
const server = vi.hoisted(() => ({ drafts: new Map<string, { text: string; queuedMessage: unknown }>() }));
vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return { api: { user: {
    drafts: () => okJson({ success: true, drafts: [...server.drafts].map(([scope, draft]) => ({ scope, ...draft })) }),
    saveDraft: (scope: string, draft: { text: string; queuedMessage: unknown }) => { server.drafts.set(scope, draft); return okJson({ success: true }); },
    deleteDraft: (scope: string) => { server.drafts.delete(scope); return okJson({ success: true }); },
  } } };
});

const routeFor = (agent: string) => ({
  decision_id: 3, decision: 'use', fallback: false, laya_error: null, create: null,
  scope: { depth: 3, task_kind: 'implement', risk: 0, remote_action: 'none', ask_clarify: false, clarify_question: null },
  agent: { id: 9, name: agent, version: 1, domain: 'x', description: '', probability: 1, confidence: 1, definition: { prompt: `${agent} prompt`, tools: null, model: null, maxTurns: null, skills: null, mcpServers: null } },
  alternatives: [], needs_new: 0, plan: { engine: 'claude', engine_locked: true, model: 'opus', effort: 'high', target: null, reason: [] },
  engines: { claude: { allowed: true, authenticated: true, score: 0.5, notes: [] }, codex: { allowed: false, authenticated: false, score: null, notes: [] } },
  lessons: [], knowledge_digest: null, latency_ms: 1, total_ms: 1, device: 'mock',
}) as unknown as RouteResult;
const hold = (since = Date.now()) => ({ design: 'apple-sidecar-interop', since, provider: 'claude' });
const queueOf = (scope: string, since?: number) => writeQueuedMessages(scope, [
  { id: 'held', content: 'Sidecar를 윈도우에서 받아줘', options: { permissionMode: 'default' }, attachments: [], hold: hold(since) },
  { id: 'other', content: '로그 정리', options: {}, attachments: [] },
]);

let routeSpy: { mock: { calls: Array<[{ forceAgent?: string | null; sessionId?: string | null }]> } };
beforeEach(() => {
  localStorage.clear();
  server.drafts.clear();
  resetChatDrafts();
  routingStore.patch({ mode: 'auto', oneShotAgent: null, oneShotPlan: null, overrides: {} });
  routeSpy = vi.spyOn(aidevApi, 'route').mockImplementation(async (input) => routeFor(input.forceAgent ?? 'generalist')) as unknown as typeof routeSpy;
  vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 77 });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('held commands', () => {
  it('only a routed command naming a design is held, never an app re-send', () => {
    const create = { design: true, background: true, proposal: { name: 'apple-sidecar-interop', domain: 'd', description: '', technologies: [] } };
    const decoration = (appResend: boolean, design = true) => ({ appResend, route: { create: design ? create : null } }) as never;
    expect(designHoldFor(decoration(false))).toBe('apple-sidecar-interop');
    expect(designHoldFor(decoration(true))).toBeNull();
    expect(designHoldFor(decoration(false, false))).toBeNull();
    expect(designHoldFor(null)).toBeNull();
  });

  it('a created design releases the command to the new specialist, routing and all; the other turns stay as they are', async () => {
    vi.spyOn(aidevApi, 'designStatus').mockResolvedValue({ status: 'created', agent: 'apple-sidecar-interop' });
    queueOf('chat-1');
    const view = renderHook(() => useDesignHolds({ watch: true }));
    await waitFor(() => expect(readQueuedMessages('chat-1')[0].hold).toBeUndefined());
    const [released, other] = readQueuedMessages('chat-1');
    expect(routeSpy.mock.calls[0][0]).toMatchObject({ forceAgent: 'apple-sidecar-interop', sessionId: 'chat-1' });
    const aidev = (released.options ?? {}).aidev as { agent: { name: string }; runId: number };
    expect(aidev.agent.name).toBe('apple-sidecar-interop');
    expect(aidev.runId).toBe(77);
    expect(released.options).toMatchObject({ permissionMode: 'default', model: 'opus', effort: 'high' });
    expect(other).toEqual({ id: 'other', content: '로그 정리', options: {}, attachments: [] });
    view.unmount();
  });

  it('a design that ended without an agent, or takes too long, sends the command to the generalist and says why', async () => {
    const notify = vi.spyOn(aidevApi, 'notifyEvent').mockResolvedValue({});
    vi.spyOn(aidevApi, 'designStatus').mockResolvedValue({ status: 'designing', agent: null });
    queueOf('chat-2', Date.now() - HOLD_MAX_MS - 1000);
    const view = renderHook(() => useDesignHolds({ watch: true }));
    await waitFor(() => expect(readQueuedMessages('chat-2')[0].hold).toBeUndefined());
    expect(routeSpy.mock.calls[0][0]).toMatchObject({ forceAgent: GENERALIST });
    expect(notify.mock.calls[0][0]).toMatchObject({ code: 'agent.design_failed', session_id: 'chat-2' });
    view.unmount();
  });

  it('a design still under way within the limit keeps the command held', async () => {
    const status = vi.spyOn(aidevApi, 'designStatus').mockResolvedValue({ status: 'designing', agent: null });
    queueOf('chat-3');
    const view = renderHook(() => useDesignHolds({ watch: true }));
    await waitFor(() => expect(status).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readQueuedMessages('chat-3')[0].hold?.design).toBe('apple-sidecar-interop');
    expect(routeSpy).not.toHaveBeenCalled();
    view.unmount();
  });
});
