import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type Engine } from '@/modules/aidev-router/api';

/**
 * The order engines are used in (2026-10-09): the first usable one runs a new chat; a limited or signed-out
 * engine is skipped; a chat that landed on a lower engine moves back once the higher one is usable again,
 * unless the user pinned that chat. Empty = the learned task-kind weights decide (the previous behaviour).
 * Shared by the workbench settings and the mobile settings screen.
 */
export function useEnginePriority() {
  // the saved order; null until loaded
  const [order, setOrder] = useState<Engine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    aidevApi.engines().then((response) => setOrder(response.engine_priority ?? [])).catch(() => undefined);
  }, []);
  /** `[]` clears the priority (learned weights). */
  const save = useCallback(async (next: Engine[]) => {
    setError(null);
    const previous = order;
    setOrder(next);
    try { setOrder((await aidevApi.setEnginePriority(next.length ? next : null)).engine_priority); }
    catch (failure) { setOrder(previous); setError(failure instanceof Error ? failure.message : '저장하지 못했습니다'); }
  }, [order]);
  return { order, error, save };
}

/** The three choices the settings offer, as orders. */
export const PRIORITY_CHOICES: Array<{ key: string; order: Engine[]; label: string; hint: string }> = [
  { key: 'auto', order: [], label: '자동', hint: '작업 종류별로 학습된 가중치가 고릅니다' },
  { key: 'claude', order: ['claude', 'codex'], label: 'Claude 우선', hint: 'Claude가 쓸 수 있으면 항상 Claude, 한도·로그아웃이면 Codex, 풀리면 Claude로 복귀' },
  { key: 'codex', order: ['codex', 'claude'], label: 'Codex 우선', hint: 'Codex가 쓸 수 있으면 항상 Codex, 한도·로그아웃이면 Claude, 풀리면 Codex로 복귀' },
];

/** Which choice a saved order is. */
export const priorityKey = (order: Engine[] | null) => (order && order.length ? (order[0] === 'claude' ? 'claude' : 'codex') : 'auto');
