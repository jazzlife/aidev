import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight, CornerDownRight, Pause, Play, Plus, Square } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { adapterFor, DEBUG_STATE_LABEL, debugStore, splitArgs, useDebugSession, useDebugSessions, useDebugStore } from '@/modules/remote-debug';
import { api, debugApi, readApiJson } from '@/shared/api';
import type { RemoteDebugSnapshot, RemoteDebugVariable } from '@/shared/types';
import { TopBar } from '@m/components/TopBar';

/**
 * Remote debugging on the phone (F-09): the same sessions as the workbench debug window — usually one an
 * agent started — with step controls, where it stopped (the code around the line, tap the dot column to
 * toggle a breakpoint), the variables (tap to expand), the stack and the program output with an
 * expression field. A new session can be started too (PC, program, breakpoints as file:line).
 */
type Tab = 'code' | 'vars' | 'stack' | 'output';
type Target = { id: number; name: string; online: boolean; allowed_roots: string[] };
const base = (p: string | null) => (p ? p.split(/[\\/]/).pop() ?? p : '?');

/** Route `/m/debug` (from the 원격 menu; `?s=<session>` selects one). */
export function DebugScreen() {
  const [params] = useSearchParams();
  const store = useDebugStore();
  const { sessions, reload } = useDebugSessions(true, 5000);
  const [tab, setTab] = useState<Tab>('code');
  const [creating, setCreating] = useState(false);
  const [frameId, setFrameId] = useState<number | null>(null);
  const [expr, setExpr] = useState('');
  const [evalLog, setEvalLog] = useState<string[]>([]);

  useEffect(() => { const s = params.get('s'); if (s) debugStore.select(s); }, [params]);
  useEffect(() => {
    if (!sessions.length) return;
    if (!store.selected || !sessions.some((s) => s.id === store.selected)) debugStore.select(sessions[0].id);
  }, [sessions, store.selected]);

  const dbg = useDebugSession(creating ? null : store.selected);
  const snap = dbg.snapshot;
  const live = snap && snap.state !== 'ended' && snap.state !== 'failed';
  const paused = snap?.state === 'paused';
  const frames = snap?.frames ?? [];
  const top = frames.find((f) => !f.internal) ?? frames[0] ?? null;
  const frame = frames.find((f) => f.id === frameId) ?? top;
  useEffect(() => { setFrameId(null); }, [snap?.stopped?.at]);

  const toggle = (line: number) => {
    if (!snap || !frame?.path) return;
    const cur = snap.breakpoints.filter((b) => b.path === frame.path).map((b) => b.line);
    void dbg.setBreakpoints(frame.path, cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line]);
  };
  const evaluate = async () => {
    const text = expr.trim();
    if (!text) return;
    setExpr('');
    const r = await dbg.evaluate(text, frame?.id ?? null);
    setEvalLog((log) => [...log.slice(-30), `› ${text}\n${r ? `= ${r.result}` : `✗ ${dbg.error ?? '실패'}`}`]);
  };

  const btn = 'm-touch flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 text-[11px] active:bg-elevated disabled:opacity-40';
  const subtitle = snap ? `${base(snap.program ?? snap.module)} · ${snap.targetName} · ${DEBUG_STATE_LABEL[snap.state]}${snap.stopped ? ` (${snap.stopped.reason})` : ''}` : sessions.length ? '불러오는 중…' : '세션 없음';
  return (
    <div className="flex h-[100dvh] flex-col bg-bg">
      <TopBar title="디버그" subtitle={creating ? '새 디버그' : subtitle} back="/"
        right={<button type="button" aria-label="새 디버그" aria-pressed={creating} onClick={() => setCreating(!creating)} className={`m-touch flex items-center justify-center rounded-full ${creating ? 'text-accent' : 'text-muted'}`}><Plus size={20} /></button>} />
      {sessions.length > 1 && !creating ? (
        <div className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2 text-[13px]">
          {sessions.map((s) => (
            <button key={s.id} type="button" onClick={() => debugStore.select(s.id)} className={`m-touch shrink-0 rounded-full px-3 py-1 ${s.id === store.selected ? 'bg-ink text-bg' : 'border border-line'}`}>{base(s.program ?? s.module)} · {DEBUG_STATE_LABEL[s.state]}{s.origin === 'agent' ? ' · agent' : ''}</button>
          ))}
        </div>
      ) : null}
      {creating || (!sessions.length && !snap) ? (
        <StartSheet onStarted={(s) => { setCreating(false); debugStore.select(s.id); void reload(); }} />
      ) : snap ? (
        <>
          {live ? (
            <div className="flex gap-1 border-b border-line px-2 py-1.5">
              {paused
                ? <button type="button" disabled={Boolean(dbg.busy)} onClick={() => { void dbg.control('continue'); }} className={`${btn} text-ok`}><Play size={18} />계속</button>
                : <button type="button" disabled={Boolean(dbg.busy) || snap.state !== 'running'} onClick={() => { void dbg.control('pause'); }} className={btn}><Pause size={18} />일시 정지</button>}
              <button type="button" disabled={!paused || Boolean(dbg.busy)} onClick={() => { void dbg.control('next'); }} className={btn}><CornerDownRight size={18} />한 줄</button>
              <button type="button" disabled={!paused || Boolean(dbg.busy)} onClick={() => { void dbg.control('stepIn'); }} className={btn}><ArrowDownToLine size={18} />안으로</button>
              <button type="button" disabled={!paused || Boolean(dbg.busy)} onClick={() => { void dbg.control('stepOut'); }} className={btn}><ArrowUpFromLine size={18} />밖으로</button>
              <button type="button" disabled={dbg.busy === 'stop'} onClick={() => { void dbg.stop().then(() => reload()); }} className={`${btn} text-danger`}><Square size={17} />중지</button>
            </div>
          ) : null}
          {paused && frame ? <div className="border-b border-line px-3 py-1.5 text-[13px]"><span className="text-warn">멈춤</span> <span className="font-medium">{frame.name}</span> <span className="font-mono text-[12px] text-muted">{base(frame.path)}:{frame.line}</span></div> : null}
          {snap.state === 'ended' ? <div className="border-b border-line px-3 py-1.5 text-[13px] text-muted">프로그램이 끝났습니다{snap.exitCode !== null ? ` (종료 코드 ${snap.exitCode})` : ''}.</div> : null}
          {snap.error || dbg.error ? <div className="border-b border-line px-3 py-1.5 text-[12px] text-danger">{snap.error ?? dbg.error}</div> : null}
          <div className="flex border-b border-line px-2 text-[13px]">
            {([['code', '코드'], ['vars', '변수'], ['stack', '스택'], ['output', '출력']] as Array<[Tab, string]>).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)} className={`m-touch flex-1 border-b-2 py-2 ${tab === id ? 'border-accent font-medium' : 'border-transparent text-muted'}`}>{label}</button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'code' ? <SourceView targetId={snap.targetId} path={frame?.path ?? null} line={frame?.line ?? null} breakpoints={snap.breakpoints.filter((b) => b.path === frame?.path).map((b) => b.line)} onToggle={toggle} /> : null}
            {tab === 'vars' ? (paused ? <Variables key={`${snap.stopped?.at}:${frame?.id}`} vars={frame?.id === top?.id ? snap.locals : []} load={dbg.variables} emptyNote={frame?.id === top?.id ? '변수 없음' : '맨 위 프레임의 변수만 보입니다'} /> : <div className="p-3 text-[13px] text-muted">프로그램이 멈추면 변수가 보입니다.</div>) : null}
            {tab === 'stack' ? (
              <div className="py-1">
                {paused ? frames.map((f) => (
                  <button key={f.id} type="button" onClick={() => { setFrameId(f.id); setTab('code'); }} className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-[13px] active:bg-elevated ${f.id === frame?.id ? 'bg-surface' : ''} ${f.internal ? 'text-muted' : ''}`}>
                    <span className="font-medium">{f.name}</span><span className="truncate font-mono text-[12px] text-muted">{base(f.path)}:{f.line}</span>
                  </button>
                )) : <div className="p-3 text-[13px] text-muted">멈춘 상태가 아닙니다.</div>}
              </div>
            ) : null}
            {tab === 'output' ? (
              <div className="flex h-full flex-col">
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px]">{dbg.output || '(출력 없음)'}{evalLog.length ? `\n${evalLog.join('\n')}` : ''}</pre>
                <form onSubmit={(e) => { e.preventDefault(); void evaluate(); }} className="flex gap-2 border-t border-line p-2 pb-safe-b">
                  <input aria-label="식 계산" value={expr} onChange={(e) => setExpr(e.target.value)} disabled={!paused} placeholder={paused ? '식 계산 — 예: len(rows)' : '멈췄을 때 계산할 수 있습니다'} className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-2 font-mono text-[13px]" />
                  <button type="submit" disabled={!paused} className="m-touch rounded-lg bg-accent px-3 text-accent-ink disabled:opacity-50">계산</button>
                </form>
              </div>
            ) : null}
          </div>
        </>
      ) : <div className="p-3 text-[13px] text-muted m-pulse">불러오는 중…</div>}
    </div>
  );
}

function SourceView({ targetId, path, line, breakpoints, onToggle }: { targetId: number; path: string | null; line: number | null; breakpoints: number[]; onToggle: (line: number) => void }) {
  const [text, setText] = useState<{ path: string; lines: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!path || text?.path === path) return;
    let alive = true;
    void (async () => {
      try { const r = await readApiJson<{ text: string }>(await api.targets.file(targetId, path)); if (alive) { setText({ path, lines: r.text.split('\n') }); setError(null); } }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { alive = false; };
  }, [targetId, path, text?.path]);
  useEffect(() => { (ref.current?.querySelector('[data-current="true"]') as HTMLElement | null)?.scrollIntoView?.({ block: 'center' }); }, [line, text]);
  if (!path) return <div className="p-3 text-[13px] text-muted">멈추면 그 파일이 여기 보입니다.</div>;
  if (error) return <div className="p-3 text-[13px] text-danger">{error}</div>;
  if (!text || text.path !== path) return <div className="p-3 text-[13px] text-muted m-pulse">{base(path)} 불러오는 중…</div>;
  const bp = new Set(breakpoints);
  return (
    <div ref={ref} className="overflow-x-auto py-1 font-mono text-[12px] leading-6">
      {text.lines.map((content, i) => {
        const n = i + 1;
        return (
          <div key={n} data-current={n === line ? 'true' : undefined} className={`flex ${n === line ? 'bg-warn/25' : ''}`}>
            <button type="button" aria-label={`${n}번째 줄 중단점`} onClick={() => onToggle(n)} className="flex w-7 shrink-0 items-center justify-center"><span className={`h-2.5 w-2.5 rounded-full ${bp.has(n) ? 'bg-danger' : 'bg-line'}`} /></button>
            <span className="w-8 shrink-0 select-none pr-2 text-right text-muted">{n}</span>
            <span className="whitespace-pre pr-4">{content || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

function Variables({ vars, load, depth = 0, emptyNote = '변수 없음' }: { vars: RemoteDebugVariable[]; load: (ref: number) => Promise<RemoteDebugVariable[]>; depth?: number; emptyNote?: string }) {
  if (!vars.length && depth === 0) return <div className="p-3 text-[13px] text-muted">{emptyNote}</div>;
  return <div>{vars.map((v, i) => <VarRow key={`${v.name}:${i}`} v={v} load={load} depth={depth} />)}</div>;
}
function VarRow({ v, load, depth }: { v: RemoteDebugVariable; load: (ref: number) => Promise<RemoteDebugVariable[]>; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<RemoteDebugVariable[] | null>(null);
  return (
    <div>
      <button type="button" onClick={() => { if (!v.ref) return; setOpen(!open); if (!children) void load(v.ref).then(setChildren).catch(() => setChildren([])); }} className="flex w-full items-baseline gap-1.5 py-1.5 pr-3 text-left font-mono text-[12px] active:bg-elevated" style={{ paddingLeft: 12 + depth * 14 }}>
        <span className="w-3 shrink-0 text-muted">{v.ref ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}</span>
        <span className="shrink-0 text-accent">{v.name}</span><span className="text-muted">=</span><span className="min-w-0 break-all">{v.value}</span>
      </button>
      {open && children ? <Variables vars={children} load={load} depth={depth + 1} /> : null}
    </div>
  );
}

/** Minimal start on the phone: PC, program, folder, breakpoints as "file:line". */
function StartSheet({ onStarted }: { onStarted: (s: RemoteDebugSnapshot) => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [program, setProgram] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [bps, setBps] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const r = await readApiJson<{ targets: Target[] }>(await api.targets.list());
        setTargets(r.targets);
        const first = r.targets.find((t) => t.online) ?? r.targets[0];
        setTargetId(first?.id ?? null);
        setCwd(first?.allowed_roots?.[0] ?? '~/aidev-work');
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, []);
  const start = async () => {
    if (!targetId || !program.trim()) return;
    setBusy(true); setError(null);
    try {
      const breakpoints = bps.split(/[\s,]+/).map((x) => /^(.+):(\d+)$/.exec(x.trim())).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => ({ path: m[1], line: Number(m[2]) }));
      const r = await readApiJson<{ session: RemoteDebugSnapshot }>(await debugApi.start(targetId, { adapter: adapterFor(program.trim()), program: program.trim(), args: splitArgs(args), cwd: cwd.trim() || undefined, breakpoints }));
      onStarted(r.session);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const field = 'w-full rounded-lg border border-line bg-surface px-2 py-2 text-[14px]';
  return (
    <div className="space-y-2 p-3 text-[13px]">
      <select aria-label="원격 PC" value={targetId ?? ''} onChange={(e) => setTargetId(Number(e.target.value) || null)} className={field}>
        {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (오프라인)'}</option>)}
      </select>
      <input aria-label="프로그램" value={program} onChange={(e) => setProgram(e.target.value)} placeholder="프로그램 (app.js · main.py · build/app)" className={field} />
      <input aria-label="인자" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="인자 (선택)" className={field} />
      <input aria-label="PC 폴더" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="PC 폴더" className={field} />
      <input aria-label="중단점" value={bps} onChange={(e) => setBps(e.target.value)} placeholder="중단점: app.py:12, src/util.js:40" className={field} />
      {error ? <div className="text-danger">{error}</div> : null}
      <button type="button" disabled={busy || !targetId || !program.trim()} onClick={() => { void start(); }} className="m-touch flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-[15px] font-medium text-accent-ink disabled:opacity-50"><Play size={15} /> {busy ? '시작하는 중…' : '디버그 시작'}</button>
      <div className="text-muted">채팅에서 agent에게 "내 PC에서 디버깅해서 원인 찾아줘"라고 해도 됩니다 — agent가 시작한 세션도 여기 나타납니다.</div>
    </div>
  );
}
