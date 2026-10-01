import { useState } from 'react';
import { Monitor, Sparkles, Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { useRoutingState, routingStore, aidevApi, claudeAuth, useClaudeAuth, useTargetChoice, type Engine } from '@/modules/aidev-router';
import { ClaudeLoginSheet } from '@m/components/ClaudeLoginSheet';
import { BottomSheet } from '@m/components/BottomSheet';
import { ChatEffortCapControl } from '@m/components/EffortCapControl';

const DEPTH_LABEL = ['즉답', '한 파일', '기능', '심층', '설계'];

/** Used by ChatScreen: one collapsed chip summarising the last routing decision; tapping opens the detail sheet. */
export function RouterChip({ sessionId = null }: { sessionId?: string | null }) {
  const state = useRoutingState();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const auth = useClaudeAuth();
  const last = state.last;
  // F-08: the PC this chat's remote work goes to (pin / automatic)
  const targetChoice = useTargetChoice(sessionId);
  const tv = targetChoice.view;
  // expired (from a route or the runtime) or due within 30 days: a tappable login notice above the chip
  const needsLogin = (last?.plan.engine_error && last.plan.engine === 'claude') || auth.expired;
  const loginNotice = needsLogin ? 'Claude 로그인 만료 · 다시 로그인' : auth.renewSoon ? `Claude 로그인 D-${auth.daysLeft} · 갱신` : null;
  if (state.mode === 'off') return <ClaudeLoginSheet />;
  const label = state.busy ? '판정 중…' : last ? `${last.agent.name} · ${last.plan.engine ?? '-'} ${last.plan.model ?? ''} · D${last.scope.depth}${last.plan.target ? ` · ⇢ ${last.plan.target.name}` : ''}` : '자동 라우팅';
  return (
    <>
      <ClaudeLoginSheet />
      {loginNotice ? <button type="button" onClick={() => claudeAuth.openDialog()} className={`mx-3 mb-1 self-start rounded-full border px-3 h-8 text-[12px] ${needsLogin ? 'border-danger/40 text-danger' : 'border-warn/40 text-warn'}`}>{loginNotice}</button> : null}
      <button type="button" onClick={() => setOpen(true)} className="mx-3 mb-1 self-start max-w-[calc(100%-24px)] flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 h-8 text-[12px] text-muted">
        <Sparkles size={13} className={state.busy ? 'm-pulse text-accent' : 'text-accent'} />
        <span className="truncate">{label}</span>
        {last?.fallback ? <span className="text-warn">· fallback</span> : null}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="라우팅">
        <div className="mb-4">
          <div className="text-[12px] text-muted mb-1">이 채팅의 추론 강도 상한</div>
          <ChatEffortCapControl sessionId={sessionId} />
        </div>
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
              <div className="flex items-center gap-2"><span className="font-medium">{last.agent.name}</span><span className="text-muted text-[12px]">{Math.round(last.agent.probability * 100)}%</span><button type="button" className="ml-auto text-[12px] text-accent" onClick={() => { setOpen(false); navigate(`/catalog/${last.agent.id}`); }}>카탈로그</button></div>
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
              <div className="text-[12px] text-muted mt-2">{last.plan.model ? `${last.plan.model} / ${last.plan.effort ?? "-"}` : "모델 미정 (사용 가능한 엔진 없음)"}{last.plan.engine_locked ? ' · 이 세션은 엔진 고정' : ''}</div>
              <ul className="text-[11px] text-muted mt-1 list-disc pl-4">{last.plan.reason.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
            {tv ? (
              <div data-testid="router-target-sheet">
                <div className="text-[12px] text-muted mb-1">원격 PC · {tv.name ? `${tv.name} (${tv.label})` : '자동'}{last.scope.remote_action !== 'none' ? ` · 원격 작업 ${last.scope.remote_action}` : ''}{tv.device ? ` · 기기 ${tv.device.serial}` : ''}</div>
                <div className="space-y-1.5">
                  <button type="button" onClick={() => { void targetChoice.choose(null); }} className={`w-full rounded-xl border px-3 py-2 text-left ${tv.selectedId === null ? 'border-accent' : 'border-line'}`}>
                    <div className="text-[13px]">자동</div><div className="text-[11px] text-muted">기본 PC → 하나뿐인 PC → Laya가 명령에 맞는 PC 선택</div>
                  </button>
                  {tv.options.map((t) => (
                    <div key={t.id} className={`flex items-center rounded-xl border ${tv.selectedId === t.id ? 'border-accent' : 'border-line'}`}>
                      <button type="button" onClick={() => { void targetChoice.choose(t.id); }} className="min-w-0 flex-1 px-3 py-2 text-left">
                        <div className="flex items-center gap-1.5 text-[13px]"><Monitor size={14} /> <span className="truncate">{t.name}</span></div>
                        <div className="text-[11px] text-muted">{t.platform ?? '?'}{t.is_default ? ' · 기본 PC' : ''} · 이 채팅에 고정</div>
                      </button>
                      <button type="button" aria-label={t.is_default ? `${t.name} 기본 PC 해제` : `${t.name} 기본 PC로 지정`} onClick={() => { void targetChoice.setDefault(t.id, !t.is_default); }} className="m-touch flex items-center justify-center text-muted">
                        <Star size={17} className={t.is_default ? 'fill-amber-400 text-amber-500' : ''} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-muted mt-1">명령에 PC 이름을 쓰면 그 PC가 우선합니다. ☆: 모든 채팅의 기본 PC.</div>
              </div>
            ) : null}
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
