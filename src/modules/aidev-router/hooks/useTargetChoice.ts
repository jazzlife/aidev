import { useCallback, useEffect, useRef, useState } from 'react';

import { aidevApi, type RouteResult, type RouteTargetSource } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState } from '@/modules/aidev-router/store';

function dropOverride() {
  const { targetId: _dropped, ...rest } = routingStore.get().overrides;
  void _dropped;
  routingStore.patch({ overrides: rest });
}

/** How the router came to the PC, in the chip's words. */
export const TARGET_SOURCE_LABEL: Record<RouteTargetSource, string> = {
  input: '직접 선택', mention: '명령에 이름', session: '이 채팅 고정', default: '기본 PC', single: '유일한 PC', laya: 'Laya 선택',
};

/**
 * What the router chip shows for the PC (F-08). A pick made since the last route is shown as it will
 * apply ("다음 명령부터"); otherwise the PC the last route used and how it was chosen, or the chat's pin
 * when the last command needed no PC. Null when no PC was online at routing time.
 *   picked: the PC picked since the last route (null = back to automatic; undefined = no pick)
 */
export function targetChipView(last: RouteResult | null, picked: number | null | undefined, pinnedId: number | null, overrideId: number | null | undefined) {
  const options = last?.targets ?? [];
  if (!last || !options.length) return null;
  const byId = (id: number | null | undefined) => (id != null ? options.find((t) => t.id === id) ?? null : null);
  const planned = last.plan.target;
  const standing = byId(overrideId) ?? byId(pinnedId);
  let name: string | null; let label: string;
  if (picked !== undefined) { name = byId(picked)?.name ?? null; label = picked === null ? '자동 (다음 명령부터)' : '다음 명령부터'; }
  else if (planned) { name = planned.name; label = planned.source ? TARGET_SOURCE_LABEL[planned.source] : ''; }
  else if (standing) { name = standing.name; label = byId(overrideId) ? TARGET_SOURCE_LABEL.input : TARGET_SOURCE_LABEL.session; }
  else { name = null; label = '자동'; }
  return { options, name, label, selectedId: picked !== undefined ? picked : standing?.id ?? null, remoteAction: last.scope.remote_action, device: last.plan.device ?? null };
}

/**
 * Used by the workbench router bar and the mobile router chip: the chat's PC pin and the override.
 * Choosing a PC pins it for this chat (server-side; a new chat without an id yet keeps it as a
 * page-level override), records the correction on the route decision and on Laya's target.select
 * decision, and applies from the next send. `null` goes back to automatic.
 */
export function useTargetChoice(sessionId: string | null) {
  const state = useRoutingState();
  // this chat's pinned PC as the gateway has it (reloaded when the chat changes)
  const [pinnedId, setPinnedId] = useState<number | null>(null);
  // the chat this hook showed before: a new chat (null) that just got its id carries its pick over as a pin
  const previousSession = useRef<string | null>(sessionId);
  useEffect(() => {
    const carried = previousSession.current === null ? routingStore.get().overrides.targetId ?? null : null;
    previousSession.current = sessionId;
    setPinnedId(null);
    if (!sessionId) return undefined;
    let alive = true;
    if (carried !== null) {
      dropOverride();
      aidevApi.setSessionTarget(sessionId, carried).then((r) => { if (alive) setPinnedId(r.target_id); }).catch(() => undefined);
    } else aidevApi.sessionTarget(sessionId).then((id) => { if (alive) setPinnedId(id); }).catch(() => undefined);
    return () => { alive = false; };
  }, [sessionId]);

  // the pick made since the last route (reset when a new route arrives)
  const [picked, setPicked] = useState<{ decisionId: number | null; id: number | null } | null>(null);
  const choose = useCallback(async (targetId: number | null) => {
    const last = routingStore.get().last;
    setPicked({ decisionId: last?.decision_id ?? null, id: targetId });
    // a known chat keeps the pick as its pin (a PC named in a later command still wins); a new chat
    // without an id yet holds it as a page-level override until the id is known
    if (sessionId || targetId === null) dropOverride(); else routingStore.setOverrides({ targetId });
    const name = targetId !== null ? last?.targets?.find((t) => t.id === targetId)?.name : null;
    if (last && name) {
      void aidevApi.overrideDecision(last.decision_id, { final_target: name }).catch(() => undefined);
      if (last.target_decision) void aidevApi.overrideDecision(last.target_decision.decision_id, { final_target: name, final_answer: name }).catch(() => undefined);
    }
    if (sessionId) {
      try { setPinnedId(await aidevApi.setSessionTarget(sessionId, targetId).then((r) => r.target_id)); } catch { /* the override still applies on this page */ }
    }
  }, [sessionId]);

  const setDefault = useCallback(async (targetId: number, on: boolean) => {
    await aidevApi.setDefaultTarget(targetId, on);
    const last = routingStore.get().last;
    // reflect it in the chip's list right away (the next route returns it anyway)
    if (last?.targets) routingStore.patch({ last: { ...last, targets: last.targets.map((t) => ({ ...t, is_default: t.id === targetId ? on : on ? false : t.is_default })) } });
  }, []);

  const pickedNow = picked && picked.decisionId === (state.last?.decision_id ?? null) ? picked.id : undefined;
  return { view: targetChipView(state.last, pickedNow, pinnedId, state.overrides.targetId), pinnedId, choose, setDefault };
}
