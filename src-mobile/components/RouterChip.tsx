import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import { useRoutingState, routingStore, aidevApi, type Engine } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';

const DEPTH_LABEL = ['즉답', '한 파일', '기능', '심층', '설계'];

/** Used by ChatScreen: one collapsed chip summarising the last routing decision; tapping opens the detail sheet. */
export function RouterChip() {
  const state = useRoutingState();
  const [open, setOpen] = useState(false);
  const last = state.last;
  if (state.mode === 'off') return null;
  const label = state.busy ? '판정 중…' : last ? `${last.agent.name} · ${last.plan.engine ?? '-'} ${last.plan.model ?? ''} · D${last.scope.depth}` : '자동 라우팅';
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="mx-3 mb-1 self-start max-w-[calc(100%-24px)] flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 h-8 text-[12px] text-muted">
        <Sparkles size={13} className={state.busy ? 'm-pulse text-accent' : 'text-accent'} />
        <span className="truncate">{label}</span>
        {last?.fallback ? <span className="text-warn">· fallback</span> : null}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="라우팅">
        {!last ? <div className="text-muted">아직 판정된 명령이 없습니다. 명령을 보내면 Laya가 전문 agent·엔진·모델을 고릅니다.</div> : (
          <div className="space-y-4">
            <div>
              <div className="text-[12px] text-muted mb-1">명령</div>
              <div className="text-[13px] line-clamp-3">{state.lastText}</div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="깊이" value={`D${last.scope.depth} ${DEPTH_LABEL[last.scope.depth] ?? ''}`} />
              <Stat label="작업" value={last.scope.task_kind} />
              <Stat label="위험" value={last.scope.risk.toFixed(1)} />
            </div>
            <div>
              <div className="text-[12px] text-muted mb-1">agent</div>
              <div className="flex items-center gap-2"><span className="font-medium">{last.agent.name}</span><span className="text-muted text-[12px]">{Math.round(last.agent.probability * 100)}%</span></div>
              <div className="h-1.5 rounded bg-elevated mt-1"><div className="h-1.5 rounded bg-accent" style={{ width: `${Math.round(last.agent.probability * 100)}%` }} /></div>
              {last.alternatives.length ? (
                <div className="mt-2 space-y-1">
                  {last.alternatives.map((alternative) => (
                    <button key={alternative.name} type="button" className="w-full text-left text-[13px] flex justify-between py-1.5 border-t border-line" onClick={() => { routingStore.setOverrides({ agent: alternative.name }); void aidevApi.overrideDecision(last.decision_id, { final_agent: alternative.name }); setOpen(false); }}>
                      <span>{alternative.name}</span><span className="text-muted">{Math.round(alternative.probability * 100)}% · 다음 명령에 사용</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div>
              <div className="text-[12px] text-muted mb-1">엔진 · 모델</div>
              <div className="flex gap-2">
                {(['claude', 'codex'] as Engine[]).map((engine) => {
                  const info = last.engines[engine];
                  const usable = info.allowed && info.authenticated;
                  return (
                    <button key={engine} type="button" disabled={!usable || last.plan.engine_locked} onClick={() => { routingStore.setOverrides({ engine }); void aidevApi.overrideDecision(last.decision_id, { final_engine: engine }); }}
                      className={`flex-1 rounded-xl border px-3 py-2 text-left disabled:opacity-40 ${(state.overrides.engine ?? last.plan.engine) === engine ? 'border-accent' : 'border-line'}`}>
                      <div className="text-[13px] capitalize">{engine}</div>
                      <div className="text-[11px] text-muted">{!info.allowed ? '계정에 없음' : !info.authenticated ? (info.error || '로그인 필요') : info.score !== null ? `점수 ${info.score.toFixed(2)}` : ''}</div>
                    </button>
                  );
                })}
              </div>
              <div className="text-[12px] text-muted mt-2">{last.plan.model} / {last.plan.effort}{last.plan.engine_locked ? ' · 이 세션은 엔진 고정' : ''}</div>
              <ul className="text-[11px] text-muted mt-1 list-disc pl-4">{last.plan.reason.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
            {last.lessons.length ? <div><div className="text-[12px] text-muted mb-1">주입된 교훈</div><ul className="text-[12px] list-disc pl-4">{last.lessons.map((lesson) => <li key={lesson.id}>{lesson.trigger} → {lesson.rule}</li>)}</ul></div> : null}
            <div className="text-[11px] text-muted">Laya {last.latency_ms ?? '-'}ms ({last.device ?? '-'}) · 전체 {last.total_ms}ms · 모드 {state.mode}</div>
          </div>
        )}
      </BottomSheet>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-elevated py-2"><div className="text-[11px] text-muted">{label}</div><div className="text-[13px] font-medium truncate px-1">{value}</div></div>;
}
