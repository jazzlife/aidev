import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleStop, FolderSync, Keyboard, Play, RefreshCw, Square, TerminalSquare, Wifi, WifiOff } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { api, readApiJson } from '@/shared/api';

/**
 * RunOutputPane (IMPLEMENTATION-PLAN §3.12, F-03): run a command on a remote PC and watch it live.
 * One WebSocket per selected target (`/api/aidev/targets/:id/stream`): the pane attaches to one
 * stream at a time (the gateway replays its last 256 KB first), types into it when it is a pty,
 * and follows runs started elsewhere (agents, another tab). Finished runs that the gateway no
 * longer keeps in memory are read from their log.
 */
type Target = { id: number; name: string; online: boolean; paired: boolean; policy: string; allowed_roots: string[]; capabilities: { os?: string } | null };
export type StreamInfo = { streamId: number; targetId: number; remoteRunId: number; cmd: string; cwd: string | null; pty: boolean; by: string | null; pid: number | null; startedAt: number; running: boolean; code: number | null; signal: string | null; durationMs: number | null; bytes: number };
type RunRow = { id: number; cmd: string | null; cwd: string | null; approved_by: string | null; started_at: number; finished_at: number | null; exit_code: number | null; artifacts: { signal?: string | null; lost?: boolean; error?: string } | null; live: StreamInfo | null };
type Selected = { remoteRunId: number; streamId: number | null };

const encoder = new TextEncoder();
const HISTORY_KEY = 'aidev.remoteRun.history';

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[]; } catch { return []; }
}
function saveHistory(cmd: string) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify([cmd, ...loadHistory().filter((c) => c !== cmd)].slice(0, 20))); } catch { /* private mode */ }
}

export function statusText(run: { running: boolean; code: number | null; signal: string | null; lost?: boolean }) {
  if (run.running) return '실행 중';
  if (run.lost) return '연결 유실';
  if (run.signal) return `중단 (${run.signal})`;
  return run.code === 0 ? '성공 (0)' : `실패 (${run.code ?? '?'})`;
}
const dot = (run: { running: boolean; code: number | null }) => (run.running ? 'bg-sky-500 animate-pulse' : run.code === 0 ? 'bg-emerald-500' : 'bg-rose-500');

/** "Show this run" requests (approval cards, chat): the pane picks them up when it is (or becomes) mounted. */
let focusRequest: { remoteRunId: number; targetId: number } | null = null;
const focusListeners = new Set<() => void>();
export function requestRunFocus(request: { remoteRunId: number; targetId: number }) {
  focusRequest = request;
  for (const fn of focusListeners) fn();
}

export function RunOutputPane({ isVisible = true, project = null }: { isVisible?: boolean; project?: { path: string; name: string } | null }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [online, setOnline] = useState(false);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [cmd, setCmd] = useState('');
  const [cwd, setCwd] = useState('');
  const [pty, setPty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const termBox = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const attached = useRef<number | null>(null);
  const selectedRef = useRef<Selected | null>(null);
  selectedRef.current = selected;
  const streamsRef = useRef<StreamInfo[]>([]);
  streamsRef.current = streams;
  const pendingSelect = useRef<number | null>(null);
  const selectRef = useRef<(remoteRunId: number) => void>(() => undefined);
  const targetIdRef = useRef<number | null>(null);
  targetIdRef.current = targetId;
  useEffect(() => {
    const apply = () => {
      const request = focusRequest;
      if (!request) return;
      focusRequest = null;
      pendingSelect.current = request.remoteRunId;
      if (targetIdRef.current !== request.targetId) { setTargetId(request.targetId); setSelected(null); setCwd(''); }
      else if (streamsRef.current.some((s) => s.remoteRunId === request.remoteRunId)) { pendingSelect.current = null; selectRef.current(request.remoteRunId); }
    };
    focusListeners.add(apply);
    apply();
    return () => { focusListeners.delete(apply); };
  }, []);

  const target = targets.find((t) => t.id === targetId) ?? null;
  const loadTargets = useCallback(() => {
    api.targets.list().then((r) => readApiJson<{ targets: Target[] }>(r)).then((body) => {
      const list = body.targets.filter((t) => t.paired);
      setTargets(list);
      setTargetId((cur) => (cur && list.some((t) => t.id === cur) ? cur : (list.find((t) => t.online) ?? list[0])?.id ?? null));
    }).catch((error: Error) => setNote(error.message));
  }, []);
  const loadRuns = useCallback((id: number) => {
    api.targets.runs(id).then((r) => readApiJson<{ runs: RunRow[] }>(r)).then((body) => setRuns(body.runs)).catch(() => undefined);
  }, []);
  useEffect(() => { if (isVisible) loadTargets(); }, [isVisible, loadTargets]);
  useEffect(() => { if (target && !cwd) setCwd(target.allowed_roots[0] ?? ''); }, [target, cwd]);

  // xterm: created once, fitted to the pane; keystrokes go to the attached stream when it is a pty
  useEffect(() => {
    if (!termBox.current || term.current) return undefined;
    const t = new Terminal({ fontSize: 13, fontFamily: 'Menlo, Monaco, "Courier New", monospace', scrollback: 20000, convertEol: true, cursorBlink: false, disableStdin: false, theme: { background: '#1e1e1e', foreground: '#d4d4d4' } });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(termBox.current);
    term.current = t; fit.current = f;
    const onData = t.onData((data) => {
      const id = attached.current;
      const st = streamsRef.current.find((s) => s.streamId === id);
      if (id && st?.pty && st.running && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ op: 'write', streamId: id, data }));
    });
    const observer = new ResizeObserver(() => {
      try { f.fit(); } catch { return; }
      const id = attached.current;
      const st = streamsRef.current.find((s) => s.streamId === id);
      if (id && st?.pty && st.running && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ op: 'resize', streamId: id, cols: t.cols, rows: t.rows }));
    });
    observer.observe(termBox.current);
    return () => { onData.dispose(); observer.disconnect(); t.dispose(); term.current = null; };
  }, []);

  const attach = useCallback((streamId: number) => {
    const ws = socket.current;
    if (attached.current && attached.current !== streamId && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'detach', streamId: attached.current }));
    attached.current = streamId;
    const st = streamsRef.current.find((s) => s.streamId === streamId);
    if (term.current) { term.current.reset(); term.current.options.convertEol = !st?.pty; }
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'attach', streamId }));
  }, []);

  // one socket per selected target, reconnecting while the pane is visible
  useEffect(() => {
    if (!targetId || !isVisible) return undefined;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;
    const connect = () => {
      const ws = new WebSocket(api.targets.streamUrl(targetId));
      ws.binaryType = 'arraybuffer';
      socket.current = ws;
      ws.onopen = () => { setConnected(true); backoff = 1000; };
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const view = new DataView(event.data);
          if (view.byteLength < 4 || view.getUint32(0) !== attached.current) return;
          term.current?.write(new Uint8Array(event.data, 4));
          return;
        }
        const msg = JSON.parse(String(event.data)) as { type: string; online?: boolean; streams?: StreamInfo[]; stream?: StreamInfo; message?: string; streamId?: number };
        if (msg.type === 'hello') {
          setOnline(Boolean(msg.online)); setStreams(msg.streams ?? []);
          streamsRef.current = msg.streams ?? [];
          if (attached.current) attach(attached.current);   // re-attach after a reconnect (replay restores the screen)
          if (pendingSelect.current) { const id = pendingSelect.current; pendingSelect.current = null; setTimeout(() => selectRef.current(id), 0); }
        } else if (msg.type === 'online' || msg.type === 'offline') {
          setOnline(msg.type === 'online');
        } else if ((msg.type === 'started' || msg.type === 'exit' || msg.type === 'attached') && msg.stream) {
          const s = msg.stream;
          setStreams((cur) => { const next = [...cur.filter((x) => x.streamId !== s.streamId), s].sort((a, b) => a.startedAt - b.startedAt); streamsRef.current = next; return next; });
          if (msg.type === 'exit') {
            loadRuns(targetId);
            if (s.streamId === attached.current) term.current?.write(`\r\n\x1b[2m── ${statusText(s)} · ${Math.round((s.durationMs ?? 0) / 100) / 10}s ──\x1b[0m\r\n`);
          }
          if (msg.type === 'started') loadRuns(targetId);
        } else if (msg.type === 'error') {
          setNote(msg.message ?? '오류');
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
    };
    connect();
    loadRuns(targetId);
    return () => { closed = true; if (retry) clearTimeout(retry); socket.current?.close(); socket.current = null; attached.current = null; };
  }, [targetId, isVisible, attach, loadRuns]);

  // selecting a run: attach to its live stream, or print its log when the gateway no longer holds it
  const select = useCallback(async (remoteRunId: number) => {
    const live = streamsRef.current.find((s) => s.remoteRunId === remoteRunId);
    setSelected({ remoteRunId, streamId: live?.streamId ?? null });
    if (live) { attach(live.streamId); return; }
    attached.current = null;
    term.current?.reset();
    try {
      const res = await api.targets.remoteRunLog(remoteRunId, { bytes: 256 * 1024 });
      const text = await res.text();
      const failed = runs.find((r) => r.id === remoteRunId)?.artifacts?.error;
      if (term.current) { term.current.options.convertEol = true; term.current.write(text || (failed ? `\x1b[31m시작 실패: ${failed}\x1b[0m` : '\x1b[2m(출력 없음 — 로그가 정리되었거나 비어 있습니다)\x1b[0m')); }
    } catch (error) { setNote((error as Error).message); }
  }, [attach, runs]);
  selectRef.current = (id: number) => { void select(id); };

  const run = async () => {
    if (!targetId || !cmd.trim()) return;
    setBusy(true); setNote(null);
    try {
      try { fit.current?.fit(); } catch { /* hidden */ }
      const body = await readApiJson<{ stream: StreamInfo }>(await api.targets.exec(targetId, { cmd: cmd.trim(), cwd: cwd || undefined, pty, cols: term.current?.cols, rows: term.current?.rows }));
      saveHistory(cmd.trim());
      setStreams((cur) => { const next = [...cur.filter((x) => x.streamId !== body.stream.streamId), body.stream]; streamsRef.current = next; return next; });
      setSelected({ remoteRunId: body.stream.remoteRunId, streamId: body.stream.streamId });
      attach(body.stream.streamId);
      if (pty) term.current?.focus();
      loadRuns(targetId);
    } catch (error) { setNote((error as Error).message); } finally { setBusy(false); }
  };

  const [syncing, setSyncing] = useState(false);
  const syncProject = async () => {
    if (!targetId || !project) return;
    setSyncing(true); setNote(null);
    try {
      const r = await readApiJson<{ data?: { dest: string; uploaded: number; deleted: number; unchanged: number; bytes: number; ms: number; skipped: string[] } } & { dest?: string }>(await api.targets.sync(targetId, project.path));
      const d = (r.data ?? r) as { dest: string; uploaded: number; deleted: number; unchanged: number; bytes: number; ms: number; skipped: string[] };
      setCwd(d.dest);
      setNote(`동기화 완료: ${project.name} → ${d.dest} · 올림 ${d.uploaded} · 지움 ${d.deleted} · 그대로 ${d.unchanged} · ${Math.round(d.bytes / 1024)}KB · ${(d.ms / 1000).toFixed(1)}초${d.skipped?.length ? ` · 큰 파일 제외 ${d.skipped.length}` : ''}`);
      if (targetId) loadRuns(targetId);
    } catch (error) { setNote((error as Error).message); } finally { setSyncing(false); }
  };

  const current = selected ? streams.find((s) => s.remoteRunId === selected.remoteRunId) ?? null : null;
  const signal = (sig: 'INT' | 'KILL') => {
    if (!current?.running || socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(JSON.stringify({ op: 'signal', streamId: current.streamId, signal: sig }));
  };
  // live streams first (newest on top), then the recorded history without duplicates
  const list = useMemo(() => {
    const liveIds = new Set(streams.map((s) => s.remoteRunId));
    const rows = runs.filter((r) => !liveIds.has(r.id)).map((r) => ({ remoteRunId: r.id, cmd: r.cmd ?? '', running: false, code: r.exit_code, signal: r.artifacts?.signal ?? null, lost: Boolean(r.artifacts?.lost || r.artifacts?.error), startedAt: r.started_at, by: r.approved_by }));
    return [...streams.map((s) => ({ remoteRunId: s.remoteRunId, cmd: s.cmd, running: s.running, code: s.code, signal: s.signal, lost: false, startedAt: s.startedAt, by: s.by })).reverse(), ...rows].slice(0, 60);
  }, [streams, runs]);
  const history = useMemo(() => (isVisible ? loadHistory() : []), [isVisible, busy]);

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-testid="run-output-pane">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <select aria-label="대상 PC" value={targetId ?? ''} onChange={(e) => { setTargetId(Number(e.target.value)); setSelected(null); setCwd(''); term.current?.reset(); }} className="h-7 rounded border border-border bg-background px-1.5">
          {targets.length === 0 ? <option value="">등록된 PC 없음</option> : null}
          {targets.map((t) => <option key={t.id} value={t.id}>{t.online ? '● ' : '○ '}{t.name}</option>)}
        </select>
        <span title={online ? '러너 연결됨' : '러너 오프라인'} className={online ? 'text-emerald-600' : 'text-muted-foreground'}>{online ? <Wifi size={14} /> : <WifiOff size={14} />}</span>
        <input aria-label="작업 폴더" list="aidev-run-roots" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="작업 폴더(허용 폴더 안)" className="h-7 w-44 min-w-0 rounded border border-border bg-background px-1.5 font-mono" />
        <datalist id="aidev-run-roots">{(target?.allowed_roots ?? []).map((r) => <option key={r} value={r} />)}</datalist>
        <input aria-label="명령" list="aidev-run-history" value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void run(); }} placeholder={target?.capabilities?.os === 'windows' ? '예: npm test' : '예: npm test   ·   npm run dev'} className="h-7 min-w-[10rem] flex-1 rounded border border-border bg-background px-1.5 font-mono" />
        <datalist id="aidev-run-history">{history.map((h) => <option key={h} value={h} />)}</datalist>
        {project ? (
          <button type="button" onClick={() => void syncProject()} disabled={!online || syncing || target?.policy === 'deny'} title={`${project.name}의 변경된 파일을 이 PC(${target?.allowed_roots[0] ?? '허용 폴더'}/${project.name})로 복사하고, 작업 폴더를 그곳으로 맞춥니다`} className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 disabled:opacity-40"><FolderSync size={13} className={syncing ? 'animate-pulse' : ''} /> {syncing ? '동기화 중…' : '프로젝트 동기화'}</button>
        ) : null}
        <label className="flex items-center gap-1 whitespace-nowrap text-muted-foreground" title="대화형 터미널(pty): 입력·색상·크기 조절. 끄면 출력만 수집합니다.">
          <input type="checkbox" checked={pty} onChange={(e) => setPty(e.target.checked)} /><Keyboard size={13} /> 대화형
        </label>
        <button type="button" onClick={() => void run()} disabled={!online || busy || !cmd.trim() || target?.policy === 'deny'} className="flex h-7 items-center gap-1 rounded bg-primary px-2.5 text-primary-foreground disabled:opacity-40"><Play size={13} /> 실행</button>
      </div>
      {note ? <div className="border-b border-border bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300">{note}</div> : null}
      {target?.policy === 'deny' ? <div className="border-b border-border px-2 py-1 text-muted-foreground">이 PC는 실행 정책이 “실행 금지”입니다 — 원격 대상에서 바꿀 수 있습니다.</div> : null}
      <div className="flex min-h-0 flex-1">
        <div className="w-52 shrink-0 overflow-y-auto border-r border-border" aria-label="실행 기록">
          <div className="flex items-center px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">실행 기록
            <button type="button" aria-label="새로고침" onClick={() => { if (targetId) loadRuns(targetId); loadTargets(); }} className="ml-auto rounded p-0.5 hover:bg-muted"><RefreshCw size={11} /></button>
          </div>
          {list.length === 0 ? <div className="px-2 py-3 text-muted-foreground">아직 실행한 명령이 없습니다.</div> : null}
          {list.map((r) => (
            <button key={r.remoteRunId} type="button" onClick={() => void select(r.remoteRunId)} className={`flex w-full items-start gap-1.5 px-2 py-1 text-left hover:bg-muted ${selected?.remoteRunId === r.remoteRunId ? 'bg-muted' : ''}`}>
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot(r)}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono">{r.cmd}</span>
                <span className="block text-[10px] text-muted-foreground">{statusText(r)} · {new Date(r.startedAt).toLocaleTimeString()}{r.by && r.by !== 'user' ? ` · ${r.by}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border px-2">
            <TerminalSquare size={12} className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono" title={current?.cmd}>{current ? `${current.cmd}` : selected ? `#${selected.remoteRunId} (로그)` : '명령을 실행하거나 기록을 고르세요'}</span>
            {current ? <span className="min-w-0 max-w-[45%] truncate whitespace-nowrap text-muted-foreground" title={current.cwd ?? undefined}>{statusText(current)}{current.pty ? ' · 대화형' : ''}{current.cwd ? ` · ${current.cwd}` : ''}</span> : null}
            {current?.running ? (
              <>
                <button type="button" title="Ctrl+C (INT)" onClick={() => signal('INT')} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 hover:bg-muted"><Square size={11} /> 중지</button>
                <button type="button" title="강제 종료 (KILL)" onClick={() => signal('KILL')} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-rose-600 hover:bg-muted"><CircleStop size={11} /> 강제 종료</button>
              </>
            ) : null}
            {!connected && targetId ? <span className="shrink-0 whitespace-nowrap text-muted-foreground">재연결 중…</span> : null}
          </div>
          <div ref={termBox} className="min-h-0 flex-1 bg-[#1e1e1e] p-1" />
        </div>
      </div>
    </div>
  );
}

export default RunOutputPane;
