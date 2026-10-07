import type { openStore } from './store.js';
import type { Engine } from './store-aidev.js';
import type { LayaClient } from './laya.js';
import { decide } from './laya-questions.js';
import { TIER_TABLE, applyEffortCap, applyModelFloor, type EngineAvailability } from './routing.js';
import { EFFORT_LADDER } from './store-aidev.js';

/**
 * What to do after a routed run fails (IMPLEMENTATION-PLAN §3.8, E-03). Laya's `escalate` picks
 * among retry_same / escalate_tier / switch_engine / ask_user; rules keep the answer executable:
 *   - the run's engine is not signed in any more  → switch_engine (else ask_user)
 *   - two escalations already chained              → ask_user (no endless retries)
 *   - escalate_tier at the top tier                 → one more effort step up to the user's ceiling,
 *                                                     then switch_engine when possible, else ask_user
 *   - switch_engine with no other usable engine     → escalate_tier / ask_user
 * The proposal is stored on the run and returned to the client, which offers it as a one-tap card;
 * nothing re-runs by itself (each attempt spends the user's subscription).
 */
type Store = ReturnType<typeof openStore>;
type RunRow = NonNullable<ReturnType<Store['run']>>;
export type NextAction = {
  action: 'retry_same' | 'escalate_tier' | 'switch_engine' | 'ask_user';
  engine: Engine | null; model: string | null; effort: string | null; depth: number | null;
  from_run: number; chain: number; reason: string;
};

const MAX_CHAIN = 2;

function chainLength(store: Store, run: RunRow) {
  let n = 0; let cur: RunRow | undefined = run;
  while (cur?.escalated_from_run && n < 10) { n++; cur = store.run(run.user_id, cur.escalated_from_run); }
  return n;
}

export async function decideNext(store: Store, laya: LayaClient, run: RunRow, engines: EngineAvailability): Promise<NextAction> {
  const engine = (run.engine === 'codex' ? 'codex' : 'claude') as Engine;
  const other: Engine = engine === 'claude' ? 'codex' : 'claude';
  const otherUsable = Boolean(engines[other]?.allowed && engines[other]?.authenticated);
  const depth = Math.max(0, Math.min(4, Math.round(run.depth ?? 1)));
  const chain = chainLength(store, run);
  const base = { from_run: run.id, chain };
  const cap = store.effectiveEffortCap(run.user_id, run.session_id).cap;
  const floor = store.effectiveModelFloor(run.user_id, run.session_id).floor;
  const plan = (action: NextAction['action'], planEngine: Engine | null, planDepth: number | null, reason: string): NextAction => {
    if (!planEngine || planDepth === null) return { ...base, action, engine: null, model: null, effort: null, depth: null, reason };
    // the user's model floor holds for the retry too (a retry never runs below the chat's floor)
    const tier = { ...TIER_TABLE[planDepth][planEngine] };
    applyModelFloor(planEngine, tier, floor[planEngine]);
    return { ...base, action, engine: planEngine, model: tier.model, effort: applyEffortCap(tier.effort, planDepth, planEngine, cap[planEngine]), depth: planDepth, reason };
  };
  // at the top tier the effort can still climb (one step per attempt) until the user's ceiling
  const ladder = EFFORT_LADDER[engine];
  const effortRoom = depth >= 4 && ladder.indexOf(run.effort ?? '') >= 0 && ladder.indexOf(run.effort ?? '') < ladder.indexOf(cap[engine]);

  if (chain >= MAX_CHAIN) return plan('ask_user', null, null, `이미 ${chain}번 이어서 시도했습니다`);
  if (!engines[engine]?.authenticated) {
    return otherUsable ? plan('switch_engine', other, depth, `${engine} 로그인이 필요해 ${other}로 넘깁니다`) : plan('ask_user', null, null, `${engine} 로그인이 필요합니다`);
  }

  const decision = store.db.prepare('SELECT command FROM decision_log WHERE id=?').get(run.decision_id ?? -1) as { command: string } | undefined;
  const signals = { exit_code: run.exit_code, tool_errors: run.tool_errors, user_feedback: run.user_feedback, reverted: run.reverted, test_result: run.test_result };
  const judged = await decide(laya, 'escalate', { state: { command: decision?.command ?? '', engine, model: run.model, depth, signals, other_engine_available: otherUsable } });
  store.logKindDecision({ userId: run.user_id, kind: judged.kind, command: decision?.command ?? '', answer: judged.answer, confidence: judged.confidence, probabilities: judged.probabilities, latencyMs: judged.latency_ms, device: judged.device, fallback: judged.fallback });
  let action = (typeof judged.answer === 'string' ? judged.answer : 'escalate_tier') as NextAction['action'];
  // Laya unavailable: stronger model first, then the other engine
  if (judged.fallback) action = depth < 4 || effortRoom ? 'escalate_tier' : (otherUsable ? 'switch_engine' : 'ask_user');
  if (action === 'escalate_tier' && depth >= 4 && !effortRoom) action = otherUsable ? 'switch_engine' : 'ask_user';
  if (action === 'switch_engine' && !otherUsable) action = depth < 4 || effortRoom ? 'escalate_tier' : 'ask_user';

  switch (action) {
    case 'retry_same': return { ...base, action, engine, model: run.model, effort: run.effort, depth, reason: '일시적인 실패로 보여 같은 설정으로 다시 시도합니다' };
    case 'escalate_tier': {
      if (depth >= 4) {
        const effort = ladder[ladder.indexOf(run.effort ?? '') + 1];
        return { ...base, action, engine, model: run.model, effort, depth: 4, reason: `최상위 모델에서 추론 강도를 ${run.effort} → ${effort}(상한 ${cap[engine]})로 올려 다시 시도합니다` };
      }
      return plan(action, engine, depth + 1, `더 강한 모델(D${depth + 1})로 다시 시도합니다`);
    }
    case 'switch_engine': return plan(action, other, depth, `${engine}가 이 작업에 막혀 ${other}로 넘깁니다`);
    default: return plan('ask_user', null, null, '추가 정보가 필요합니다');
  }
}
