import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';
import type { RemoteDebugVariable } from '@/shared/types';

/**
 * Pieces of the debug window (F-09): the source of the paused file with a breakpoint gutter, and an
 * expandable variables tree. Used by DebugPane (workbench) and DebugScreen (mobile).
 */

/** The file as it is on the PC (read through the runner), current line marked, gutter clicks toggle breakpoints. */
export function DebugSourceView({ targetId, path, line, breakpoints, onToggle, compact = false }: {
  targetId: number; path: string | null; line: number | null; breakpoints: number[]; onToggle: (line: number) => void; compact?: boolean;
}) {
  // file text by path (kept while the session steps through the same file)
  const [text, setText] = useState<{ path: string; lines: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!path || text?.path === path) return;
    let alive = true;
    setError(null);
    void (async () => {
      try {
        const r = await readApiJson<{ text: string }>(await api.targets.file(targetId, path));
        if (alive) setText({ path, lines: r.text.split('\n') });
      } catch (e) { if (alive) { setText(null); setError(e instanceof Error ? e.message : String(e)); } }
    })();
    return () => { alive = false; };
  }, [targetId, path, text?.path]);
  // keep the current line in view
  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-current="true"]');
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
  }, [line, text]);
  if (!path) return <div className="p-3 text-xs text-muted-foreground">멈춘 곳이 없습니다 — 중단점에 멈추면 그 파일이 여기 보입니다.</div>;
  if (error) return <div className="aidev-selectable p-3 text-xs text-red-600">{path}: {error}</div>;
  if (!text || text.path !== path) return <div className="p-3 text-xs text-muted-foreground">불러오는 중… {path}</div>;
  const bp = new Set(breakpoints);
  return (
    <div ref={scrollRef} className={`h-full overflow-auto font-mono ${compact ? 'text-[11px]' : 'text-xs'} leading-5`}>
      {text.lines.map((content, i) => {
        const n = i + 1;
        const current = n === line;
        return (
          <div key={n} data-current={current ? 'true' : undefined} className={`flex ${current ? 'bg-yellow-300/30' : ''}`}>
            <button type="button" aria-label={`${n}번째 줄 중단점`} onClick={() => onToggle(n)} className="group flex w-5 shrink-0 items-center justify-center">
              <span className={`h-2.5 w-2.5 rounded-full ${bp.has(n) ? 'bg-red-600' : 'bg-red-600/0 group-hover:bg-red-600/35'}`} />
            </button>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">{n}</span>
            <span className="aidev-selectable whitespace-pre pr-4">{content || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Variables; rows with `ref` > 0 open to show their children (loaded when opened). */
export function DebugVariables({ vars, load, depth = 0 }: { vars: RemoteDebugVariable[]; load: (ref: number) => Promise<RemoteDebugVariable[]>; depth?: number }) {
  if (!vars.length && depth === 0) return <div className="p-2 text-xs text-muted-foreground">변수 없음</div>;
  return <div>{vars.map((v, i) => <VariableRow key={`${v.name}:${i}`} v={v} load={load} depth={depth} />)}</div>;
}

function VariableRow({ v, load, depth }: { v: RemoteDebugVariable; load: (ref: number) => Promise<RemoteDebugVariable[]>; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<RemoteDebugVariable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (!v.ref) return;
    setOpen(!open);
    if (!children) {
      try { setChildren(await load(v.ref)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
  };
  return (
    <div>
      <button type="button" onClick={() => { void toggle(); }} className="flex w-full items-baseline gap-1 px-2 py-0.5 text-left font-mono text-xs hover:bg-muted" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="w-3 shrink-0 text-muted-foreground">{v.ref ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}</span>
        <span className="shrink-0 text-sky-700 dark:text-sky-400">{v.name}</span>
        <span className="text-muted-foreground">=</span>
        <span className="aidev-selectable min-w-0 truncate" title={v.value}>{v.value}</span>
        {v.type ? <span className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground">{v.type}</span> : null}
      </button>
      {open && error ? <div className="px-2 text-xs text-red-600" style={{ paddingLeft: 22 + depth * 14 }}>{error}</div> : null}
      {open && children ? <DebugVariables vars={children} load={load} depth={depth + 1} /> : null}
    </div>
  );
}
