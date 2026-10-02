import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Monitor, Square } from 'lucide-react';

import { aidevApi, type RemoteRun } from '@/modules/aidev-router';

/**
 * Mobile result card for a command run on a remote PC (F-03): target, command, status, exit code and
 * the last lines of output (ANSI stripped). While the run is live it polls every 2 s and can be
 * interrupted. The same card goes into the chat when an agent runs something remotely (F-05).
 */
const running = (run: RemoteRun) => Boolean(run.live?.running) || (!run.finished_at && !run.artifacts?.lost);

export function runStatus(run: RemoteRun) {
  if (running(run)) return { label: '실행 중', tone: 'text-accent' };
  if (run.artifacts?.lost) return { label: '연결 유실', tone: 'text-muted' };
  if (run.artifacts?.error) return { label: '시작 실패', tone: 'text-danger' };
  const signal = run.live?.signal ?? run.artifacts?.signal;
  if (signal) return { label: `중단 (${signal})`, tone: 'text-warn' };
  return run.exit_code === 0 ? { label: '성공 · 0', tone: 'text-ok' } : { label: `실패 · ${run.exit_code ?? '?'}`, tone: 'text-danger' };
}

function duration(run: RemoteRun) {
  const ms = run.live?.durationMs ?? run.artifacts?.duration_ms ?? (run.finished_at ? run.finished_at - run.started_at : Date.now() - run.started_at);
  return ms < 60_000 ? `${Math.round(ms / 100) / 10}초` : `${Math.floor(ms / 60_000)}분 ${Math.round((ms % 60_000) / 1000)}초`;
}

export function RemoteRunCard({ run: initial, lines = 12 }: { run: RemoteRun; lines?: number }) {
  const [run, setRun] = useState(initial);
  const [log, setLog] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const live = running(run);
  const refresh = useCallback(async () => {
    try {
      const [r, text] = await Promise.all([aidevApi.remoteRun(run.id), aidevApi.remoteRunLog(run.id, open ? 65536 : 8192)]);
      setRun(r.run); setLog(text);
    } catch (error) { setNote((error as Error).message); }
  }, [run.id, open]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [live, refresh]);
  const status = runStatus(run);
  const shown = (log ?? '').replace(/^\n+|\n+$/g, '').split('\n');
  const tail = open ? shown.slice(-400) : shown.slice(-lines);
  return (
    <div className="rounded-xl border border-line bg-surface p-3" data-testid="remote-run-card">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Monitor size={13} /><span className="truncate">{run.target_name ?? `대상 #${run.target_id}`}</span>
        <span className="ml-auto whitespace-nowrap">{new Date(run.started_at).toLocaleTimeString()} · {duration(run)}</span>
      </div>
      <div className="mt-1 flex items-start gap-2">
        <code className="flex-1 break-all text-[14px] font-medium">{run.cmd}</code>
        <span className={`whitespace-nowrap text-[13px] font-medium ${status.tone}`}>{live ? <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-accent align-middle" /> : null}{status.label}</span>
      </div>
      {log !== null ? (
        <pre className={`mt-2 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-elevated p-2 font-mono text-[11px] leading-[1.35] ${open ? 'max-h-[60vh]' : 'max-h-48'}`}>{tail.join('\n') || (run.artifacts?.error ? `시작 실패: ${run.artifacts.error}` : '(출력 없음)')}</pre>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        {shown.length > lines ? (
          <button type="button" className="flex items-center gap-1 text-[12px] text-muted" onClick={() => setOpen(!open)}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{open ? '접기' : '전체 출력'}</button>
        ) : null}
        {live ? (
          <button type="button" className="ml-auto flex h-9 items-center gap-1 rounded-xl border border-line px-3 text-[13px]" onClick={() => { void aidevApi.remoteRunSignal(run.id, 'INT').then(() => refresh()).catch((error: Error) => setNote(error.message)); }}><Square size={13} /> 중지</button>
        ) : null}
      </div>
      {note ? <div className="mt-1 text-[12px] text-danger">{note}</div> : null}
    </div>
  );
}
