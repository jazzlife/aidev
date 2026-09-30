import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Bug, CornerDownRight, FileCode2, Pause, Play, Plus, Square } from 'lucide-react';

import { DEBUG_STATE_LABEL, debugStore, guessPathMap, toRuntimePath, toTargetPath, useDebugSession, useDebugSessions, useDebugStore } from '@/modules/remote-debug';
import { DebugStartForm, type DebugProject } from '@/modules/remote-target/DebugStartForm';
import { DebugSourceView, DebugVariables } from '@/modules/remote-target/DebugParts';
import type { RemoteDebugSession, RemoteDebugState, RemoteDebugVariable } from '@/shared/types';

const STATE_TONE: Record<RemoteDebugState, string> = { starting: 'text-sky-600', running: 'text-emerald-600', paused: 'text-amber-600', ended: 'text-muted-foreground', failed: 'text-red-600' };
type Tab = 'variables' | 'stack' | 'breakpoints' | 'console';
const base = (p: string | null) => (p ? p.split(/[\\/]/).pop() ?? p : '?');
const sameLines = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * DebugPane (IMPLEMENTATION-PLAN §3.12, F-09): remote debugging in the workbench. A program runs under a
 * real debugger on the user's PC (js-debug / debugpy / codelldb, driven by the gateway); here the user —
 * or the agent, through remote_debug_* on the same session — sets breakpoints, steps, and reads the stack,
 * the variables and the program output. Breakpoints set in the code editor's gutter go to the session for
 * files of the mapped project (workspace project ↔ PC folder), and those the session has come back to the
 * editor; the paused line is highlighted in the editor too. Keys: F5 continue, F10 over, F11 in, ⇧F11 out.
 * Used by WorkbenchLayout as a live window (desktop, tablet, narrow screens) and by LiveWindowPage.
 */
export function DebugPane({ isVisible = true, project = null, onOpenFile }: { isVisible?: boolean; project?: DebugProject | null; onOpenFile?: (path: string, line: number) => void }) {
  const store = useDebugStore();
  const { sessions, reload } = useDebugSessions(isVisible, 5000);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>('variables');
  // the frame the user picked in the stack (default: the top frame of their own code)
  const [frameId, setFrameId] = useState<number | null>(null);
  const [frameVars, setFrameVars] = useState<RemoteDebugVariable[] | null>(null);
  const [expr, setExpr] = useState('');
  const [evalLog, setEvalLog] = useState<Array<{ expr: string; result: string; error?: boolean }>>([]);
  // narrow window: source above the tabs instead of beside them
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the newest session is shown unless the user picked one; a new session (an agent's) takes over
  const seenRef = useRef(0);
  useEffect(() => {
    const newest = sessions[0];
    if (!newest) return;
    if (!store.selected || !sessions.some((s) => s.id === store.selected) || newest.createdAt > seenRef.current) {
      if (seenRef.current && newest.createdAt > seenRef.current) debugStore.select(newest.id);
      else if (!store.selected || !sessions.some((s) => s.id === store.selected)) debugStore.select(newest.id);
    }
    seenRef.current = Math.max(seenRef.current, newest.createdAt);
  }, [sessions, store.selected]);

  const dbg = useDebugSession(creating ? null : store.selected, isVisible);
  const snap = dbg.snapshot;
  const live = snap && snap.state !== 'ended' && snap.state !== 'failed';
  const map = snap ? store.maps[snap.id] ?? guessPathMap(snap.cwd, project?.path ?? null) : null;
  const frames = snap?.frames ?? [];
  const topUser = frames.find((f) => !f.internal) ?? frames[0] ?? null;
  const frame = frames.find((f) => f.id === frameId) ?? topUser;
  const stopKey = snap?.stopped ? `${snap.id}:${snap.stopped.at}` : null;
  useEffect(() => { setFrameId(null); setFrameVars(null); }, [stopKey]);

  // where it is paused → the editor highlights that line (when the file maps into the workspace)
  useEffect(() => {
    if (!snap) return;
    if (snap.stopped && frame?.path) debugStore.setPaused({ sessionId: snap.id, targetPath: frame.path, runtimePath: toRuntimePath(frame.path, map), line: frame.line });
    else debugStore.setPaused(null);
  }, [snap, frame, map]);

  // variables of a frame other than the top one
  useEffect(() => {
    if (!frame || !topUser || frame.id === topUser.id || !snap?.stopped) { setFrameVars(null); return; }
    let alive = true;
    void (async () => {
      try {
        const scopes = await dbg.scopes(frame.id);
        const first = scopes.find((s) => !/global|static|register/i.test(s.name)) ?? scopes[0];
        const vars = first?.ref ? await dbg.variables(first.ref) : [];
        if (alive) setFrameVars(vars);
      } catch { if (alive) setFrameVars([]); }
    })();
    return () => { alive = false; };
    // dbg's functions are stable per session; the frame decides
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.id, topUser?.id, stopKey]);

  // ---- breakpoints: editor (workspace paths) ⇄ session (PC paths), for files of the mapped project -------
  const bpKey = snap ? JSON.stringify(snap.breakpoints.map((b) => [b.path, b.line])) : '';
  const syncRef = useRef<{ session: string | null; store: Record<string, number[]> | null }>({ session: null, store: null });
  useEffect(() => {
    if (!snap || !live || !map) return;
    const bySession = new Map<string, number[]>();
    for (const b of snap.breakpoints) bySession.set(b.path, [...(bySession.get(b.path) ?? []), b.line]);
    const sorted = (l: number[]) => [...l].sort((a, b) => a - b);
    const ref = syncRef.current;
    if (ref.session !== snap.id || ref.store === store.breakpoints) {
      // first look at this session, or the session's breakpoints changed (agent, this window's gutter):
      // while a session runs, what it has is what will pause — the editor shows exactly that for the project
      const runtimeFiles = new Set(Object.keys(store.breakpoints).filter((p) => toTargetPath(p, map)));
      for (const [path, lines] of bySession) { const r = toRuntimePath(path, map); if (r) { runtimeFiles.delete(r); debugStore.setLines(r, lines); } }
      for (const r of runtimeFiles) debugStore.setLines(r, []);
      syncRef.current = { session: snap.id, store: debugStore.get().breakpoints };
      return;
    }
    // the editor changed: send the files that differ
    syncRef.current.store = store.breakpoints;
    const files = new Set([...Object.keys(store.breakpoints), ...[...bySession.keys()].map((p) => toRuntimePath(p, map)).filter((p): p is string => Boolean(p))]);
    for (const r of files) {
      const t = toTargetPath(r, map);
      if (!t) continue;
      const want = sorted(store.breakpoints[r] ?? []);
      if (!sameLines(want, sorted(bySession.get(t) ?? []))) void dbg.setBreakpoints(t, want);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.breakpoints, bpKey, snap?.id, live, map?.runtimeRoot, map?.targetRoot]);

  const toggleSource = (line: number) => {
    if (!snap || !frame?.path) return;
    const cur = snap.breakpoints.filter((b) => b.path === frame.path).map((b) => b.line);
    void dbg.setBreakpoints(frame.path, cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line]);
  };

  const evaluate = async () => {
    const text = expr.trim();
    if (!text) return;
    setExpr('');
    const r = await dbg.evaluate(text, frame?.id ?? null);
    setEvalLog((log) => [...log.slice(-50), r ? { expr: text, result: r.result } : { expr: text, result: dbg.error ?? '실패', error: true }]);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (!snap || !live || (e.target as HTMLElement).closest('input, textarea, select')) return;
    const act = e.key === 'F5' ? (snap.state === 'paused' ? 'continue' : 'pause') : e.key === 'F10' ? 'next' : e.key === 'F11' ? (e.shiftKey ? 'stepOut' : 'stepIn') : null;
    if (!act) return;
    e.preventDefault();
    void dbg.control(act);
  };

  const iconBtn = 'inline-flex h-7 w-7 items-center justify-center rounded hover:bg-muted disabled:opacity-40';
  const paused = snap?.state === 'paused';
  const runtimePath = frame?.path ? toRuntimePath(frame.path, map) : null;
  const vars = frame && topUser && frame.id !== topUser.id ? frameVars ?? [] : snap?.locals ?? [];
  const sessionLabel = (s: RemoteDebugSession) => `${base(s.program ?? s.module ?? s.args[0] ?? s.adapter)} · ${s.targetName} · ${DEBUG_STATE_LABEL[s.state]}${s.origin === 'agent' ? ' · agent' : ''}`;
  const bpList = snap?.breakpoints ?? [];

  const source = snap ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2 text-[11px] text-muted-foreground">
        <FileCode2 size={12} />
        <span className="aidev-selectable truncate" title={frame?.path ?? ''}>{frame?.path ?? '—'}{frame ? `:${frame.line}` : ''}</span>
        {runtimePath && onOpenFile && frame ? <button type="button" onClick={() => onOpenFile(runtimePath, frame.line)} className="ml-auto shrink-0 rounded px-1.5 hover:bg-muted hover:text-foreground">편집기에서 열기</button> : null}
      </div>
      <div className="min-h-0 flex-1">
        <DebugSourceView targetId={snap.targetId} path={frame?.path ?? null} line={frame?.line ?? null} breakpoints={bpList.filter((b) => b.path === frame?.path).map((b) => b.line)} onToggle={toggleSource} />
      </div>
    </div>
  ) : null;

  const panel = snap ? (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border px-1 text-[11px]">
        {([['variables', '변수'], ['stack', '호출 스택'], ['breakpoints', `중단점 ${bpList.length}`], ['console', '콘솔']] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={`rounded px-2 py-0.5 ${tab === id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{label}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'variables' ? (paused ? <DebugVariables key={`${stopKey}:${frame?.id}`} vars={vars} load={dbg.variables} /> : <div className="p-2 text-xs text-muted-foreground">프로그램이 멈추면 변수가 보입니다.</div>) : null}
        {tab === 'stack' ? (
          paused ? (
            <div className="py-1">
              {frames.map((f) => (
                <button key={f.id} type="button" onClick={() => setFrameId(f.id)} className={`flex w-full items-baseline gap-2 px-2 py-0.5 text-left text-xs hover:bg-muted ${f.id === frame?.id ? 'bg-muted' : ''} ${f.internal ? 'text-muted-foreground' : ''}`}>
                  <span className="shrink-0 font-medium">{f.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground" title={f.path ?? ''}>{base(f.path)}:{f.line}</span>
                </button>
              ))}
            </div>
          ) : <div className="p-2 text-xs text-muted-foreground">멈춘 상태가 아닙니다.</div>
        ) : null}
        {tab === 'breakpoints' ? (
          <div className="py-1 text-xs">
            {bpList.length ? bpList.map((b) => (
              <div key={`${b.path}:${b.line}`} className="flex items-center gap-2 px-2 py-0.5 hover:bg-muted">
                <span className={`h-2 w-2 shrink-0 rounded-full ${b.verified === false ? 'border border-red-600' : 'bg-red-600'}`} title={b.verified === false ? '코드에 연결되지 않음' : '연결됨'} />
                <span className="aidev-selectable truncate font-mono" title={b.path}>{base(b.path)}:{b.line}</span>
                {b.message && b.verified === false ? <span className="truncate text-muted-foreground">{b.message}</span> : null}
                <button type="button" onClick={() => { void dbg.setBreakpoints(b.path, bpList.filter((x) => x.path === b.path && x.line !== b.line).map((x) => x.line)); }} className="ml-auto shrink-0 text-muted-foreground hover:text-red-600">삭제</button>
              </div>
            )) : <div className="px-2 text-muted-foreground">없음 — 편집기나 이 창의 줄 번호 왼쪽을 눌러 추가</div>}
          </div>
        ) : null}
        {tab === 'console' ? (
          <div className="flex h-full flex-col">
            <pre className="aidev-selectable min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px]">{dbg.output || '(출력 없음)'}{evalLog.map((l) => `\n› ${l.expr}\n${l.error ? '✗' : '='} ${l.result}`).join('')}</pre>
            <form onSubmit={(e) => { e.preventDefault(); void evaluate(); }} className="flex shrink-0 gap-1 border-t border-border p-1">
              <input aria-label="식 계산" value={expr} onChange={(e) => setExpr(e.target.value)} disabled={!live} placeholder={paused ? '식 계산 (멈춘 프레임 기준) — 예: user.items.length' : '멈췄을 때 식을 계산할 수 있습니다'} className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-xs text-foreground" />
            </form>
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKey} className="flex h-full min-h-0 flex-col bg-background text-sm outline-none" data-testid="debug-pane">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Bug size={14} className="shrink-0 text-muted-foreground" />
        <select aria-label="디버그 세션" value={creating ? '' : store.selected ?? ''} onChange={(e) => { setCreating(false); debugStore.select(e.target.value || null); }} className="h-7 min-w-0 max-w-64 flex-1 rounded border border-border bg-background px-1 text-xs text-foreground">
          {!sessions.length || creating ? <option value="">{creating ? '새 디버그' : '세션 없음'}</option> : null}
          {sessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
        </select>
        {snap && !creating ? <span className={`shrink-0 text-xs ${STATE_TONE[snap.state]}`}>{DEBUG_STATE_LABEL[snap.state]}{snap.stopped ? ` (${snap.stopped.reason})` : ''}{snap.exitCode !== null && snap.state === 'ended' ? ` · 종료 코드 ${snap.exitCode}` : ''}</span> : null}
        <div className="ml-auto flex shrink-0 items-center">
          {snap && live && !creating ? (
            <>
              {paused
                ? <button type="button" title="계속 (F5)" aria-label="계속" disabled={Boolean(dbg.busy)} onClick={() => { void dbg.control('continue'); }} className={`${iconBtn} text-emerald-600`}><Play size={15} /></button>
                : <button type="button" title="일시 정지 (F5)" aria-label="일시 정지" disabled={Boolean(dbg.busy) || snap.state !== 'running'} onClick={() => { void dbg.control('pause'); }} className={iconBtn}><Pause size={15} /></button>}
              <button type="button" title="한 줄 실행 (F10)" aria-label="한 줄 실행" disabled={!paused || Boolean(dbg.busy)} onClick={() => { void dbg.control('next'); }} className={iconBtn}><CornerDownRight size={15} /></button>
              <button type="button" title="안으로 (F11)" aria-label="안으로" disabled={!paused || Boolean(dbg.busy)} onClick={() => { void dbg.control('stepIn'); }} className={iconBtn}><ArrowDownToLine size={15} /></button>
              <button type="button" title="밖으로 (⇧F11)" aria-label="밖으로" disabled={!paused || Boolean(dbg.busy)} onClick={() => { void dbg.control('stepOut'); }} className={iconBtn}><ArrowUpFromLine size={15} /></button>
              <button type="button" title="중지" aria-label="중지" disabled={dbg.busy === 'stop'} onClick={() => { void dbg.stop().then(() => reload()); }} className={`${iconBtn} text-red-600`}><Square size={14} /></button>
            </>
          ) : null}
          <button type="button" title="새 디버그" aria-label="새 디버그" onClick={() => setCreating(!creating)} className={`${iconBtn} ${creating ? 'bg-muted' : ''}`}><Plus size={15} /></button>
        </div>
      </div>
      {dbg.error && !creating ? <div className="aidev-selectable shrink-0 border-b border-border px-2 py-1 text-xs text-red-600">{dbg.error}</div> : null}
      {snap?.error && !creating ? <div className="aidev-selectable shrink-0 whitespace-pre-wrap border-b border-border px-2 py-1 text-xs text-red-600">{snap.error}</div> : null}
      {creating || (!sessions.length && !snap) ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <DebugStartForm project={project} onStarted={() => { setCreating(false); void reload(); }} onCancel={sessions.length ? () => setCreating(false) : undefined} />
          {!sessions.length ? <div className="px-3 pb-3 text-xs text-muted-foreground">채팅에서 agent에게 "내 PC에서 디버깅해서 원인 찾아줘"라고 해도 되고, agent가 시작한 세션도 여기 나타납니다.</div> : null}
        </div>
      ) : snap ? (
        <div className={`flex min-h-0 flex-1 ${narrow ? 'flex-col' : 'flex-row'}`}>
          <div className={`flex min-h-0 flex-col ${narrow ? 'h-[45%] border-b' : 'w-[58%] border-r'} border-border`}>{source}</div>
          <div className="flex min-h-0 flex-1 flex-col">{panel}</div>
        </div>
      ) : <div className="p-3 text-xs text-muted-foreground">불러오는 중…</div>}
    </div>
  );
}
