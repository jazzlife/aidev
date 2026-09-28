import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Lock, RefreshCw, RotateCcw } from 'lucide-react';

import { aidevApi, type EngineWeightRow, type TierPolicyCell, type TierPolicyView } from '@/modules/aidev-router/api';

const when = (at: number | null) => (at ? new Date(at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '없음');

/**
 * Used by AgentCatalog for administrators: the learned model tier per agent domain × depth × engine
 * (E-05) — which cells moved off the table, their success rate at the current tier, the change log,
 * and pin / reset / run-now controls. Collapsed by default.
 */
export function TierPolicyPanel() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TierPolicyView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [weights, setWeights] = useState<EngineWeightRow[] | null>(null);
  const load = useCallback(() => {
    aidevApi.tierPolicy().then(setView).catch((error: Error) => setNote(error.message));
    aidevApi.engineWeights().then((response) => setWeights(response.rows)).catch(() => setWeights(null));
  }, []);
  useEffect(() => { if (open && !view) load(); }, [open, view, load]);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setNote(null);
    try { await work(); if (done) setNote(done); load(); } catch (error) { setNote(error instanceof Error ? error.message : '실패'); }
  };
  const levelOf = (cell: TierPolicyCell) => cell.level ?? cell.depth;
  const tierText = (cell: TierPolicyCell, level: number) => { const tier = view?.table[level]?.[cell.engine]; return tier ? `D${level} ${tier.model}/${tier.effort}` : `D${level}`; };
  const cells = [...(view?.cells ?? [])].sort((a, b) => Number(b.level !== null) - Number(a.level !== null) || (b.success_n + b.fail_n) - (a.success_n + a.fail_n));

  return (
    <div className="border-b border-border px-3 py-2" data-testid="tier-policy">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1 text-muted-foreground">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<Gauge size={12} /> 등급 정책·엔진 가중치 (관리자)
        {view ? <span className="ml-auto text-[10px]">조정 {view.cells.filter((cell) => cell.level !== null).length} · 마지막 집계 {when(view.last_run)}</span> : null}
      </button>
      {open ? (
        <div className="mt-1.5 space-y-2">
          <div className="text-[11px] text-muted-foreground">실행 결과로 분야×깊이×엔진마다 모델 등급을 조정합니다: 성공률 60% 미만(5회 이상) 상향, 90% 이상(10회 이상) 한 단계 하향, 하향 후 75% 미만이면 복귀. 매일 1회.</div>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => { void act(async () => { const result = await aidevApi.runTierPolicy(); setNote(`등급 ${result.cells}칸·변경 ${result.changes.length}건, 엔진 가중치 변경 ${result.weights?.changes.length ?? 0}건`); }); }} className="inline-flex h-6 items-center gap-1 rounded border border-border px-2 hover:bg-accent"><RefreshCw size={11} /> 지금 집계</button>
          </div>
          {note ? <div className="text-muted-foreground">{note}</div> : null}
          {!view ? <div className="text-muted-foreground">불러오는 중…</div> : cells.length === 0 ? <div className="text-muted-foreground">아직 집계할 실행이 없습니다.</div> : (
            <table className="w-full text-[11px]">
              <thead><tr className="text-left text-muted-foreground"><th className="font-normal">분야·깊이·엔진</th><th className="font-normal">적용 등급</th><th className="text-right font-normal">성공률</th><th /></tr></thead>
              <tbody>{cells.map((cell) => {
                const n = cell.success_n + cell.fail_n;
                const moved = cell.level !== null;
                return (
                  <tr key={`${cell.domain}-${cell.depth}-${cell.engine}`} className="border-t border-border/50">
                    <td className="py-0.5">{cell.domain} D{cell.depth} {cell.engine}</td>
                    <td className={moved ? (levelOf(cell) > cell.depth ? 'text-amber-600' : 'text-emerald-600') : 'text-muted-foreground'}>{moved ? tierText(cell, levelOf(cell)) : '표 기본값'}{cell.pinned ? <Lock size={10} className="ml-0.5 inline" /> : null}</td>
                    <td className="text-right">{n ? `${Math.round((cell.success_n / n) * 100)}% (${n})` : '-'}</td>
                    <td className="whitespace-nowrap text-right">
                      {moved || cell.pinned ? <button type="button" title="표 기본값으로 초기화" aria-label="초기화" onClick={() => { void act(() => aidevApi.setTierPolicy({ domain: cell.domain, depth: cell.depth, engine: cell.engine, level: null })); }} className="rounded p-0.5 hover:bg-accent"><RotateCcw size={11} /></button> : null}
                      <button type="button" title={cell.pinned ? '고정 해제' : '현재 등급으로 고정'} aria-label="고정" onClick={() => { void act(() => aidevApi.setTierPolicy({ domain: cell.domain, depth: cell.depth, engine: cell.engine, level: cell.level, pinned: !cell.pinned })); }} className={`rounded p-0.5 hover:bg-accent ${cell.pinned ? 'text-primary' : ''}`}><Lock size={11} /></button>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
          {weights?.length ? (
            <div>
              <div className="text-muted-foreground" title="작업 종류별 엔진 기본 점수. 최근 30일 성공률을 사전값 쪽으로 보정(가상 10회)해 매일 갱신, 성공률이 비슷하면 20% 이상 빠른 엔진 +0.05.">엔진 가중치 (작업 종류별, 학습)</div>
              <table className="w-full text-[11px]">
                <tbody>{[...new Set(weights.map((row) => row.task_kind))].map((kind) => (
                  <tr key={kind} className="border-t border-border/50">
                    <td className="py-0.5">{kind}</td>
                    {(['claude', 'codex'] as const).map((engine) => {
                      const row = weights.find((entry) => entry.task_kind === kind && entry.engine === engine);
                      const n = row ? row.success_n + row.fail_n : 0;
                      return (
                        <td key={engine} className="text-right">
                          {engine} <span className={row && row.prior !== null && Math.abs(row.weight - row.prior) >= 0.02 ? 'font-medium text-foreground' : ''}>{row ? row.weight.toFixed(2) : '-'}</span>
                          <span className="text-muted-foreground">{n ? ` (${row!.success_n}/${n})` : ''}</span>
                          {row ? <button type="button" aria-label="가중치 고정" title={row.pinned ? '고정 해제' : '현재 값으로 고정'} onClick={() => { void act(() => aidevApi.setEngineWeight({ task_kind: kind, engine, weight: row.weight, pinned: !row.pinned })); }} className={`ml-0.5 rounded p-0.5 hover:bg-accent ${row.pinned ? 'text-primary' : 'text-muted-foreground'}`}><Lock size={10} /></button> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : null}
          {view?.log.length ? (
            <div>
              <div className="text-muted-foreground">변경 기록</div>
              <ul className="max-h-32 overflow-auto text-[11px] text-muted-foreground">{view.log.slice(0, 20).map((entry) => <li key={entry.id}>· {new Date(entry.at).toISOString().slice(5, 16).replace('T', ' ')} {entry.domain} D{entry.depth} {entry.engine}: {entry.from_model} → {entry.to_model} <span className="text-foreground/70">({entry.reason}; {entry.actor})</span></li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
