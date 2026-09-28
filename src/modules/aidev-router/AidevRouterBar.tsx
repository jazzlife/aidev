import { useEffect, useState } from 'react';
import { ChevronDown, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';

import { aidevApi, type Engine, type EnginesResult } from '@/modules/aidev-router/api';
import { routingStore, useRoutingState, type RoutingMode } from '@/modules/aidev-router/store';
import { useAidevRouting } from '@/modules/aidev-router/hooks/useAidevRouting';
import { claudeAuth, useClaudeAuth } from '@/modules/aidev-router/hooks/useClaudeAuth';
import { ClaudeLoginDialog } from '@/modules/aidev-router/ClaudeLoginPanel';

const DEPTH_LABEL = ['즉답', '한 파일', '기능', '심층', '설계'];
const MODES: Array<{ value: RoutingMode; label: string }> = [{ value: 'auto', label: '자동' }, { value: 'manual', label: '확인 후' }, { value: 'off', label: '끄기' }];

/**
 * Used by the workbench chat (ChatInterface, above the composer): one line summarising the last
 * routing decision — scope chips, agent with probability, engine/model — with dropdowns to override
 * the agent, the engine and the routing mode (IMPLEMENTATION-PLAN §3.6 / C-09). Overrides are
 * recorded on the decision and applied to the next send.
 */
export function AidevRouterBar() {
  const state = useRoutingState();
  const { reportOutcome } = useAidevRouting();
  const [engines, setEngines] = useState<EnginesResult | null>(null);
  const [open, setOpen] = useState<'agent' | 'engine' | 'mode' | null>(null);
  const claudeAuthState = useClaudeAuth();
  useEffect(() => { aidevApi.engines().then(setEngines).catch(() => setEngines(null)); }, [state.last?.decision_id]);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  const last = state.last;
  const chip = 'inline-flex items-center gap-1 h-6 px-2 rounded-md border border-border bg-background text-[11px] text-muted-foreground whitespace-nowrap';
  const overrideAgent = (name: string) => { routingStore.setOverrides({ agent: name }); if (last) void aidevApi.overrideDecision(last.decision_id, { final_agent: name }); setOpen(null); };
  const overrideEngine = (engine: Engine) => { routingStore.setOverrides({ engine }); if (last) void aidevApi.overrideDecision(last.decision_id, { final_engine: engine }); setOpen(null); };

  // Expired (before any route has said so) or due for renewal within 30 days: offer the login here.
  const authNotice = !last?.plan.engine_error && claudeAuthState.expired
    ? { tone: 'text-red-600 border-red-300', label: 'Claude 로그인 만료 · 다시 로그인' }
    : claudeAuthState.renewSoon ? { tone: 'text-amber-600 border-amber-300', label: `Claude 로그인 D-${claudeAuthState.daysLeft} · 갱신` } : null;

  return (
    <div className="aidev-chrome flex items-center gap-1.5 overflow-x-auto border-t border-border/60 bg-muted/20 px-3 py-1 text-[11px]" data-testid="aidev-router-bar">
      <ClaudeLoginDialog />
      {authNotice ? <button type="button" className={`${chip} ${authNotice.tone}`} onClick={(event) => { event.stopPropagation(); claudeAuth.openDialog(); }}>{authNotice.label}</button> : null}
      <Sparkles size={13} className={`shrink-0 ${state.busy ? 'animate-pulse text-primary' : 'text-primary/80'}`} />
      {state.mode === 'off' ? <span className="text-muted-foreground">라우팅 꺼짐</span> : !last ? <span className="text-muted-foreground">{state.busy ? '판정 중…' : '명령을 보내면 전문 agent·엔진·모델을 고릅니다'}</span> : (
        <>
          <span className={chip} title={`깊이 ${last.scope.depth_raw.toFixed(2)} · 작업 ${last.scope.task_kind} (${Math.round(last.scope.task_kind_probability * 100)}%) · 위험 ${last.scope.risk.toFixed(1)}`}>
            D{last.scope.depth} {DEPTH_LABEL[last.scope.depth]} · {last.scope.task_kind} · 위험 {last.scope.risk.toFixed(0)}
          </span>
          <span className="relative">
            <button type="button" className={`${chip} text-foreground`} onClick={(event) => { event.stopPropagation(); setOpen(open === 'agent' ? null : 'agent'); }} title={last.agent.description}>
              <span className="font-medium">{state.overrides.agent ?? last.agent.name}</span>
              <span className="text-muted-foreground">{Math.round(last.agent.probability * 100)}%</span>
              {last.fallback ? <span className="text-amber-600">fallback</span> : null}
              <ChevronDown size={11} />
            </button>
            {last.plan.engine_error ? (
              last.plan.engine === 'claude'
                ? <button type="button" className={`${chip} border-red-300 text-red-600 hover:bg-red-50`} title={last.plan.engine_error} onClick={(event) => { event.stopPropagation(); claudeAuth.openDialog(); }}>Claude 로그인 만료 · 다시 로그인</button>
                : <span className={`${chip} border-red-300 text-red-600`} title={last.plan.engine_error}>{last.plan.engine}: 로그인 필요 (설정 → Agents)</span>
            ) : null}
            {open === 'agent' ? (
              <div className="absolute left-0 top-7 z-30 w-72 rounded-md border border-border bg-popover p-1 shadow-md" onClick={(event) => event.stopPropagation()}>
                {[{ name: last.agent.name, probability: last.agent.probability, description: last.agent.description }, ...last.alternatives].map((alternative) => (
                  <button key={alternative.name} type="button" onClick={() => overrideAgent(alternative.name)} className="w-full rounded px-2 py-1.5 text-left hover:bg-accent">
                    <div className="flex justify-between"><span className="font-medium">{alternative.name}</span><span className="text-muted-foreground">{Math.round(alternative.probability * 100)}%</span></div>
                    <div className="line-clamp-2 text-muted-foreground">{alternative.description}</div>
                  </button>
                ))}
                {last.decision === 'create' || last.decision === 'create_background' ? <div className="px-2 py-1 text-amber-700">맞는 전문 agent가 없습니다 — 생성 흐름(단계 D)</div> : null}
              </div>
            ) : null}
          </span>
          <span className="relative">
            <button type="button" className={`${chip} text-foreground`} disabled={last.plan.engine_locked} onClick={(event) => { event.stopPropagation(); setOpen(open === 'engine' ? null : 'engine'); }} title={last.plan.reason.join('\n')}>
              <span className="capitalize">{state.overrides.engine ?? last.plan.engine ?? '엔진 없음'}</span>
              {last.plan.model ? <span className="text-muted-foreground">· {last.plan.model}/{last.plan.effort}</span> : null}
              {last.plan.target ? <span className="text-muted-foreground">· ⇢ {last.plan.target.name}</span> : null}
              {!last.plan.engine_locked ? <ChevronDown size={11} /> : null}
            </button>
            {open === 'engine' ? (
              <div className="absolute left-0 top-7 z-30 w-64 rounded-md border border-border bg-popover p-1 shadow-md" onClick={(event) => event.stopPropagation()}>
                {(['claude', 'codex'] as Engine[]).map((engine) => {
                  const info = engines?.engines[engine] ?? last.engines[engine];
                  const usable = info.allowed && info.authenticated;
                  return (
                    <button key={engine} type="button" disabled={!usable} onClick={() => overrideEngine(engine)} className="w-full rounded px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50">
                      <div className="flex justify-between"><span className="font-medium capitalize">{engine}</span><span className="text-muted-foreground">{last.engines[engine].score !== null ? `점수 ${last.engines[engine].score?.toFixed(2)}` : ''}</span></div>
                      <div className="text-muted-foreground">{!info.allowed ? '이 계정에서 사용 불가' : !info.authenticated ? (info.error || '로그인 필요') : '사용 가능'}</div>
                    </button>
                  );
                })}
                <div className="px-2 pt-1 text-muted-foreground">{last.plan.reason.map((reason) => <div key={reason}>· {reason}</div>)}</div>
              </div>
            ) : null}
          </span>
          {last.lessons.length ? <span className={chip} title={last.lessons.map((lesson) => `${lesson.trigger} → ${lesson.rule}`).join('\n')}>교훈 {last.lessons.length}</span> : null}
          {state.runFinishedAt && state.runId ? (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground" title="이 실행 결과를 평가하면 다음 라우팅과 교훈 학습에 반영됩니다">
              <span className="mr-0.5">결과</span>
              <button type="button" aria-label="좋아요" disabled={Boolean(state.runFeedback)} onClick={() => { void reportOutcome({ user_feedback: 'up' }); }} className={`rounded p-1 hover:bg-accent disabled:opacity-60 ${state.runFeedback === 'up' ? 'text-emerald-600' : ''}`}><ThumbsUp size={12} /></button>
              <button type="button" aria-label="별로예요" disabled={Boolean(state.runFeedback)} onClick={() => { void reportOutcome({ user_feedback: 'down' }); }} className={`rounded p-1 hover:bg-accent disabled:opacity-60 ${state.runFeedback === 'down' ? 'text-red-600' : ''}`}><ThumbsDown size={12} /></button>
            </span>
          ) : null}
          <span className="ml-auto whitespace-nowrap text-muted-foreground">{last.latency_ms ?? '-'}ms{last.device ? ` · ${last.device}` : ''}</span>
        </>
      )}
      <span className="relative ml-auto">
        <button type="button" className={chip} onClick={(event) => { event.stopPropagation(); setOpen(open === 'mode' ? null : 'mode'); }}>{MODES.find((mode) => mode.value === state.mode)?.label}<ChevronDown size={11} /></button>
        {open === 'mode' ? (
          <div className="absolute right-0 top-7 z-30 w-40 rounded-md border border-border bg-popover p-1 shadow-md" onClick={(event) => event.stopPropagation()}>
            {MODES.map((mode) => <button key={mode.value} type="button" onClick={() => { routingStore.setMode(mode.value); setOpen(null); }} className={`w-full rounded px-2 py-1.5 text-left hover:bg-accent ${state.mode === mode.value ? 'font-medium' : ''}`}>{mode.label}</button>)}
            {Object.keys(state.overrides).length ? <button type="button" onClick={() => { routingStore.clearOverrides(); setOpen(null); }} className="w-full rounded px-2 py-1.5 text-left text-muted-foreground hover:bg-accent">override 지우기</button> : null}
          </div>
        ) : null}
      </span>
    </div>
  );
}
