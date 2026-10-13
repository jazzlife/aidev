import { useCallback, useEffect, useState } from 'react';

import { aidevApi, type Engine, type ProviderPolicyPatch, type ProviderPolicyView, type RouteResult, type ScoreIndex } from '@/modules/aidev-router/api';
import { ENGINE_LABELS } from '@/shared/constants';
import { isAidevEngine } from '@/shared/utils';

/**
 * Provider policy (2026-10-13, docs/aidev/PROVIDER-ENGINE-PLAN.md): the work order (kept until a usage limit), the
 * verification order, the score index and each provider's range (model floor..ceiling × effort floor..ceiling split
 * over D0..D4). Every save returns the gateway's whole view, D0..D4 preview included, so the screen never computes
 * the split itself. Shared by the workbench settings and the mobile settings screen.
 */
export function useProviderPolicy() {
  // the gateway's view; null until loaded
  const [view, setView] = useState<ProviderPolicyView | null>(null);
  // the last failed load or save, shown under the section
  const [error, setError] = useState<string | null>(null);
  // a save in flight: the controls wait for its answer
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    aidevApi.providerPolicy().then(setView).catch((failure) => setError(failure instanceof Error ? failure.message : '불러오지 못했습니다'));
  }, []);
  const apply = useCallback(async (call: () => Promise<ProviderPolicyView>) => {
    setError(null); setSaving(true);
    try { setView(await call()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '저장하지 못했습니다'); }
    finally { setSaving(false); }
  }, []);
  /** One provider's range; the gateway checks it as a whole. */
  const setProvider = useCallback((patch: ProviderPolicyPatch) => apply(() => aidevApi.setProviderPolicy(patch)), [apply]);
  /** The work order; [] = the learned weights decide. */
  const setWorkPriority = useCallback((order: Engine[]) => apply(async () => { await aidevApi.setEnginePriority(order.length ? order : null); return aidevApi.providerPolicy(); }), [apply]);
  /** The verification order; [] = the worker's other provider first. */
  const setVerifyPriority = useCallback((order: Engine[]) => apply(() => aidevApi.setVerifyPriority(order.length ? order : null)), [apply]);
  const setScoreIndex = useCallback((index: ScoreIndex) => apply(() => aidevApi.setScoreIndex(index)), [apply]);
  return { view, error, saving, setProvider, setWorkPriority, setVerifyPriority, setScoreIndex };
}

/** Providers that have a policy (a range tab in the settings): the engines routing picks between. */
export const isPolicyProvider = (provider: string): provider is Engine => isAidevEngine(provider);

/** The labels of the score indexes (Artificial Analysis). */
export const SCORE_INDEX_LABEL: Record<ScoreIndex, string> = { coding: 'Coding Index (기본)', intelligence: 'Intelligence Index', agentic: 'Agentic Index' };

/** An order with one engine moved up (-1) or down (+1); out of range leaves it as it is. */
export function moveInOrder(order: Engine[], engine: Engine, delta: -1 | 1): Engine[] {
  const index = order.indexOf(engine);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Why the last route ran where it did, in one line for the router bar and the mobile routing sheet: a provider passed
 * over on a usage limit ("Claude 한도 → Codex") and where the provider policy's split landed ("범위 5/8", "상한·최대").
 * null when neither applies (the tier table picked on the first provider).
 */
export function policyNote(route: Pick<RouteResult, 'plan' | 'engines'>, now = Date.now()): string | null {
  const name = (engine: Engine) => ENGINE_LABELS[engine] ?? engine;
  const parts: string[] = [];
  const picked = route.plan.engine;
  const limited = (Object.keys(route.engines) as Engine[]).filter((engine) => engine !== picked && (route.engines[engine]?.limited_until ?? 0) > now);
  if (picked && limited.length && !route.plan.engine_locked) parts.push(`${limited.map(name).join('·')} 한도 → ${name(picked)}`);
  const step = route.plan.step;
  if (step) parts.push(`범위 ${step.index + 1}/${step.total}${step.q2 ? ' · 상한·최대' : step.mode === 'score' && step.score !== null ? ` · 점수 ${step.score}` : ''}`);
  return parts.length ? parts.join(' · ') : null;
}

/** A step of the preview as one line ("opus · medium", "상한·최대" when Q2 applied). */
export function stepLabel(step: { model: string; effort: string | null; q2: boolean } | null, modelLabel: (model: string) => string = (model) => model): string {
  if (!step) return '—';
  return `${modelLabel(step.model)}${step.effort ? ` · ${step.effort}` : ''}${step.q2 ? ' (상한·최대)' : ''}`;
}
