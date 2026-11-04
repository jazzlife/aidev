import { useCallback, useRef } from 'react';

import { aidevApi, type AgentDraft, parseAgentDraft } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState } from '@/modules/aidev-router/store';

type UseAgentCreationArgs = {
  /** Text of the newest assistant message in the open session (the architect's answer). */
  getLastAssistantText: () => string | null;
  /** The chat on screen (null: a new chat without an id yet). */
  getOpenSessionId: () => string | null;
  /** Sends text as a new user turn through the composer (routing runs again). */
  resend: (text: string) => void;
};

/**
 * Drives the agent creation flow (IMPLEMENTATION-PLAN §3.7 / D-02, D-03) for both apps:
 *   architect turn completes → parse <aidev-agent> → review card → approve → POST /agents →
 *   original command re-sent with the new agent → optional self-check turn judged by Laya.
 * Used by ChatInterface (workbench) and the mobile ChatScreen.
 */
export function useAgentCreation({ getLastAssistantText, getOpenSessionId, resend }: UseAgentCreationArgs) {
  const state = useRoutingState();
  const pending = state.pendingCreate;

  /** The newest reply of the flow's chat: from the screen when it is open, else as the runtime stored it. */
  const readReply = useCallback(async (sessionId: string | null) => {
    const openId = getOpenSessionId();
    if (!sessionId || !openId || sessionId === openId) return getLastAssistantText();
    return aidevApi.lastAssistantText(sessionId).catch(() => null);
  }, [getLastAssistantText, getOpenSessionId]);

  /**
   * Call when a provider `complete` event arrives, for any chat: only the run of the flow's own chat moves it on.
   * Server run #1473 (2026-11-04): the user went to another chat while the architect designed, and that chat's run
   * ending read its reply, found no design block and failed the creation.
   */
  const onRunComplete = useCallback(async (finishedSessionId: string | null) => {
    const current = routingStore.get().pendingCreate;
    if (!current || (current.sessionId && finishedSessionId && finishedSessionId !== current.sessionId)) return;
    const sessionId = current.sessionId ?? finishedSessionId;
    if (current.stage === 'architect') {
      const text = await readReply(sessionId);
      // the screen may lag the final reply: the stored one is the fallback
      const stored = !text?.includes('</aidev-agent>') && sessionId ? await aidevApi.lastAssistantText(sessionId).catch(() => null) : null;
      const draft = parseAgentDraft(stored ?? text ?? '');
      if (routingStore.get().pendingCreate !== current) return;
      routingStore.patch({ pendingCreate: { ...current, stage: 'review', draft, error: draft ? null : 'agent 설계 블록(<aidev-agent>)을 찾지 못했습니다. 다시 시도하거나 직접 카탈로그에서 만들 수 있습니다.' } });
      // automatic routing: the new specialist is created and the original command runs with it right away
      // (the card stays so the user can open or retire the agent); manual mode waits for the user's approval
      if (draft && routingStore.get().mode === 'auto') await approveRef.current?.(draft);
      return;
    }
    if (current.stage === 'selfcheck' && current.draft?.self_check) {
      const output = ((await readReply(sessionId)) ?? '').slice(0, 4000);
      const result = await aidevApi.decide('selfcheck.pass', { task: current.draft.self_check.task, expected: current.draft.self_check.expected, output }).catch(() => null);
      const pass = result && typeof result.answer === 'number' ? result.answer >= 0.7 : null;
      if (current.agentId && pass !== null) void aidevApi.updateAgent(current.agentId, { verified: pass }).catch(() => null);
      routingStore.patch({ pendingCreate: { ...current, stage: 'done', selfCheckResult: { pass, confidence: result?.confidence ?? 0, note: result?.fallback ? `Laya 판정 불가 (${result.reason ?? 'fallback'}) — 직접 확인해 주세요` : pass ? '자가 검증 통과' : '기대 결과를 충족하지 못했습니다' } } });
    }
  }, [readReply]);

  const approveRef = useRef<((draft: AgentDraft) => Promise<void>) | null>(null);
  const approve = useCallback(async (draft: AgentDraft) => {
    const current = routingStore.get().pendingCreate;
    if (!current) return;
    try {
      const created = await aidevApi.createAgent({ name: draft.name, domain: draft.domain, hint: draft.hint, description: draft.description, prompt: draft.prompt, tools: draft.tools, examples: draft.examples, knowledge: draft.knowledge, source: 'generated', ...(current.queueId ? { queue_id: current.queueId } : {}) });
      // D-04: a queued domain has nothing to re-send — its commands already ran. The re-send goes to the chat on
      // screen, so it waits for the architect's chat: elsewhere it would land in an unrelated conversation.
      const openId = getOpenSessionId();
      const resendSkipped = Boolean(current.originalText && current.sessionId && openId && openId !== current.sessionId);
      const resendNow = Boolean(current.originalText) && !resendSkipped;
      routingStore.patch({ pendingCreate: { ...current, stage: 'done', draft, agentId: created.agent.id, agentName: created.agent.name, error: null, resendSkipped }, oneShotAgent: resendNow ? created.agent.name : null });
      if (resendNow) resend(current.originalText);
    } catch (error) {
      routingStore.patch({ pendingCreate: { ...current, error: error instanceof Error ? error.message : '생성 실패' } });
    }
  }, [getOpenSessionId, resend]);

  approveRef.current = approve;

  const runSelfCheck = useCallback(() => {
    const current = routingStore.get().pendingCreate;
    if (!current?.draft?.self_check || !current.agentName) return;
    // the self-check runs in the chat on screen, so its run is the one to wait for
    routingStore.patch({ pendingCreate: { ...current, stage: 'selfcheck', selfCheckResult: null, sessionId: getOpenSessionId() ?? current.sessionId }, oneShotAgent: current.agentName });
    resend(`[자가 검증] ${current.draft.self_check.task}\n\n기대 결과: ${current.draft.self_check.expected}`);
  }, [getOpenSessionId, resend]);

  const dismiss = useCallback(() => { routingStore.patch({ pendingCreate: null, oneShotAgent: null }); }, []);

  return { pending, onRunComplete, approve, runSelfCheck, dismiss };
}
