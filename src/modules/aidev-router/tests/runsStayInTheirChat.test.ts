import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aidevApi, type NextAction, type RouteResult, type RunView } from '@/modules/aidev-router/api';
import { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
import { useEscalation } from '@/modules/aidev-router/hooks/useEscalation';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * Runs go on in several chats at once while one is on screen. Server run #1736 (2026-11-09): the MyDrives chat's
 * verifier failed its run while the NewHyOn-Web chat was open, and the retry — MyDrives' command plus the findings —
 * was sent into NewHyOn-Web, because the routing state kept one "last run" for the whole page.
 */
const route = {
  decision_id: 3, decision: 'use', fallback: false, laya_error: null, create: null,
  scope: { depth: 4, task_kind: 'ops', risk: 1, remote_action: 'none', ask_clarify: false, clarify_question: null },
  agent: { id: 1, name: 'generalist', version: 1, domain: 'meta', description: '', probability: 1, confidence: 1, definition: { prompt: '', tools: null, model: null, maxTurns: null, skills: null, mcpServers: null } },
  alternatives: [], needs_new: 0, plan: { engine: 'claude', engine_locked: true, model: 'opus', effort: 'xhigh', target: null, reason: [] },
  engines: { claude: { allowed: true, authenticated: true, score: 0.5, notes: [] } },
  lessons: [], knowledge_digest: null, latency_ms: 1, total_ms: 1, device: 'mock',
} as unknown as RouteResult;
const retry: NextAction = { action: 'retry_worker', engine: 'claude', model: 'opus', effort: 'xhigh', depth: 4, from_run: 10, chain: 0, reason: '검증자가 지적한 문제' };
const failed = { verdict: 'fail', summary: '미완성', checked: [], issues: ['mydrives-ui에 src/main.rs가 없음'], engine: 'codex', model: null, at: 1 };
const chat = (sessionId: string) => ({ sessionId, provider: 'claude', isNewSession: false, userPinnedModel: false });

/** Sends in MyDrives (run 10), then in NewHyOn-Web (run 11) — the page's last send is now NewHyOn-Web's. */
async function sendInBoth() {
  vi.spyOn(aidevApi, 'route').mockResolvedValue(route);
  vi.spyOn(aidevApi, 'createRun').mockResolvedValueOnce({ run_id: 10 }).mockResolvedValueOnce({ run_id: 11 });
  const { result } = renderHook(() => useAidevRouting());
  await act(async () => { await result.current.beforeSend('심플 버전을 만들고 고도화하는 작업을 해.', chat('mydrives')); });
  await act(async () => { await result.current.beforeSend('로그인 화면 고쳐줘', chat('newhyon')); });
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  routingStore.patch({ mode: 'auto', oneShotAgent: null, oneShotPlan: null, oneShotCreate: null, overrides: {}, sent: {}, escalations: {}, verifications: {}, runId: null, last: null, lastText: null });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a routed run stays with the chat it ran in', () => {
  it("a chat's run ending is reported as that chat's run, not the page's last send", async () => {
    const routing = await sendInBoth();
    const outcome = vi.spyOn(aidevApi, 'runOutcome').mockResolvedValue({ run: {} });
    await act(async () => { await routing.current.reportOutcome({ exit_code: 0, session_id: 'mydrives' }); });
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(outcome.mock.calls[0][0]).toBe(10);
    // reported once, however many chat panes heard the same `complete`
    await act(async () => { await routing.current.reportOutcome({ exit_code: 0, session_id: 'mydrives' }); });
    expect(outcome).toHaveBeenCalledTimes(1);
  });

  it('a run this page did not route (another device, a timer) is not reported against another run', async () => {
    const routing = await sendInBoth();
    const outcome = vi.spyOn(aidevApi, 'runOutcome').mockResolvedValue({ run: {} });
    await act(async () => { await routing.current.reportOutcome({ exit_code: 0, session_id: 'elsewhere' }); });
    expect(outcome).not.toHaveBeenCalled();
  });

  it("a verifier's retry waits in its own chat and is sent there, never into the chat on screen", async () => {
    const routing = await sendInBoth();
    vi.spyOn(aidevApi, 'runOutcome').mockResolvedValue({ run: {}, verifying: true });
    vi.spyOn(aidevApi, 'run').mockResolvedValue({ run: { id: 10, outcome: 'fail', test_result: 'fail', verification: failed, next_action: retry, session_id: 'mydrives' }, verifying: false } as unknown as RunView);
    await act(async () => { await routing.current.reportOutcome({ exit_code: 0, session_id: 'mydrives' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(routingStore.get().verifications.mydrives).toMatchObject({ runId: 10, status: 'done' });
    expect(routingStore.get().verifications.newhyon).toBeUndefined();
    expect(routingStore.get().escalations.newhyon).toBeUndefined();
    expect(routingStore.get().escalations.mydrives?.text).toMatch(/^심플 버전을 만들고 고도화하는 작업을 해\.[\s\S]*src\/main\.rs/);

    // NewHyOn-Web is on screen: nothing is sent there
    const resendHere = vi.fn();
    renderHook(() => useEscalation({ sessionId: 'newhyon', resend: resendHere, openSession: vi.fn(), getProjectPath: () => null }));
    await act(async () => { await Promise.resolve(); });
    expect(resendHere).not.toHaveBeenCalled();

    // back in MyDrives: the retry goes out there, with MyDrives' own agent
    const resendThere = vi.fn();
    renderHook(() => useEscalation({ sessionId: 'mydrives', resend: resendThere, openSession: vi.fn(), getProjectPath: () => null }));
    await act(async () => { await Promise.resolve(); });
    expect(resendThere).toHaveBeenCalledTimes(1);
    expect(resendThere.mock.calls[0][0]).toMatch(/^심플 버전을 만들고 고도화하는 작업을 해\./);
    expect(routingStore.get().oneShotPlan).toMatchObject({ escalatedFromRun: 10 });
    expect(routingStore.get().escalations.mydrives).toBeUndefined();
  });

  it("a send in another chat leaves a verification that is still running in its chat", async () => {
    const routing = await sendInBoth();
    vi.spyOn(aidevApi, 'runOutcome').mockResolvedValue({ run: {}, verifying: true });
    await act(async () => { await routing.current.reportOutcome({ exit_code: 0, session_id: 'mydrives' }); });
    expect(routingStore.get().verifications.mydrives).toMatchObject({ runId: 10, status: 'pending' });
    vi.spyOn(aidevApi, 'createRun').mockResolvedValue({ run_id: 12 });
    await act(async () => { await routing.current.beforeSend('하나 더', chat('newhyon')); });
    expect(routingStore.get().verifications.mydrives).toMatchObject({ runId: 10, status: 'pending' });
  });
});
