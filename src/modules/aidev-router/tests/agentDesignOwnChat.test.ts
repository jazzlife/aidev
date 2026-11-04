import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { aidevApi } from '@/modules/aidev-router/api';
import { useAgentCreation } from '@/modules/aidev-router/hooks/useAgentCreation';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * Server run #1473 (2026-11-04): the architect designed in a new chat while the user went on in another one; that
 * chat's run ending read its own reply, found no <aidev-agent> block, and the creation failed. The flow follows the
 * architect's chat: another chat's run is ignored, and the design is read from the architect's chat even off screen.
 */
const block = '<aidev-agent>{"name":"image-animation","domain":"이미지 애니메이션","hint":"animated GIF from still images","description":"정지 이미지를 움직이는 GIF로 만든다","prompt":"당신은 정지 이미지를 움직이는 결과물로 만드는 전문가다."}</aidev-agent>';
const pendingArchitect = { stage: 'architect' as const, originalText: '단일 이미지로 움직이는 gif 만들어줘', sessionId: null, decisionId: 1, draft: null, agentId: null, agentName: null, selfCheckResult: null, error: null };

beforeEach(() => {
  vi.restoreAllMocks();
  routingStore.patch({ mode: 'auto', pendingCreate: null, oneShotAgent: null });
});

describe('agent design follows its own chat', () => {
  it('a new chat id binds the design started there', () => {
    routingStore.patch({ pendingCreate: pendingArchitect });
    routingStore.adoptSession('arch');
    expect(routingStore.get().pendingCreate?.sessionId).toBe('arch');
  });

  it('another chat ending does not fail the design, and its finish off screen creates the agent without a stray re-send', async () => {
    const createSpy = vi.spyOn(aidevApi, 'createAgent').mockResolvedValue({ agent: { id: 9, name: 'image-animation' } } as never);
    const storedSpy = vi.spyOn(aidevApi, 'lastAssistantText').mockResolvedValue(`설계했습니다.\n\n${block}`);
    routingStore.patch({ pendingCreate: { ...pendingArchitect, sessionId: 'arch' } });
    const resend = vi.fn();
    // the user is on another chat whose reply has no design block
    const { result } = renderHook(() => useAgentCreation({ getLastAssistantText: () => '빌드 성공', getOpenSessionId: () => 'other', resend }));

    await act(async () => { await result.current.onRunComplete('other'); });
    expect(routingStore.get().pendingCreate).toMatchObject({ stage: 'architect', error: null });

    await act(async () => { await result.current.onRunComplete('arch'); });
    expect(storedSpy).toHaveBeenCalledWith('arch');
    expect(createSpy.mock.calls[0][0]).toMatchObject({ name: 'image-animation' });
    expect(routingStore.get().pendingCreate).toMatchObject({ stage: 'done', agentName: 'image-animation', resendSkipped: true });
    expect(resend).not.toHaveBeenCalled();
  });

  it('on screen, the architect chat re-sends the original command with the new agent', async () => {
    vi.spyOn(aidevApi, 'createAgent').mockResolvedValue({ agent: { id: 9, name: 'image-animation' } } as never);
    routingStore.patch({ pendingCreate: { ...pendingArchitect, sessionId: 'arch' } });
    const resend = vi.fn();
    const { result } = renderHook(() => useAgentCreation({ getLastAssistantText: () => block, getOpenSessionId: () => 'arch', resend }));
    await act(async () => { await result.current.onRunComplete('arch'); });
    expect(resend).toHaveBeenCalledWith('단일 이미지로 움직이는 gif 만들어줘');
    expect(routingStore.get().oneShotAgent).toBe('image-animation');
  });
});
