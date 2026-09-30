import { useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';

import { adapterFor, debugStore, defaultTargetFolder, splitArgs, toTargetPath, useDebugStore } from '@/modules/remote-debug';
import { api, debugApi, readApiJson } from '@/shared/api';
import type { RemoteDebugAdapter, RemoteDebugLaunch, RemoteDebugSnapshot } from '@/shared/types';

/** A PC as GET /api/aidev/targets reports it (the fields this form needs). */
type Target = { id: number; name: string; online: boolean; allowed_roots: string[]; is_default?: number | boolean; capabilities: { features?: string[]; runner?: string; tools?: Record<string, string> } | null };
export type DebugProject = { path: string; name: string };

const ADAPTERS: Array<{ id: RemoteDebugAdapter; label: string }> = [
  { id: 'js-debug', label: 'Node.js (js-debug)' },
  { id: 'debugpy', label: 'Python (debugpy)' },
  { id: 'codelldb', label: 'C/C++/Rust (codelldb)' },
];
const RUNTIMES = ['node', 'npm', 'npx', 'yarn', 'pnpm', 'tsx'];

/**
 * "새 디버그" (F-09): what to run under the debugger on which PC. The workspace project is copied to the PC
 * first (remote_sync, changed files only) unless unticked; the editor's breakpoints in that project go
 * along (as paths relative to the PC folder). Used by DebugPane.
 */
export function DebugStartForm({ project, onStarted, onCancel }: { project: DebugProject | null; onStarted: (session: RemoteDebugSnapshot) => void; onCancel?: () => void }) {
  const store = useDebugStore();
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [program, setProgram] = useState('');
  // null = follow the program's extension
  const [adapterPick, setAdapterPick] = useState<RemoteDebugAdapter | null>(null);
  const [runtime, setRuntime] = useState('node');
  const [runtimeArgs, setRuntimeArgs] = useState('');
  const [module, setModule] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [cwdEdited, setCwdEdited] = useState(false);
  const [sync, setSync] = useState(Boolean(project));
  const [stopOnEntry, setStopOnEntry] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await readApiJson<{ targets: Target[] }>(await api.targets.list());
        setTargets(r.targets);
        setTargetId((cur) => cur ?? (r.targets.find((t) => t.online && t.is_default) ?? r.targets.find((t) => t.online) ?? r.targets[0])?.id ?? null);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, []);
  const target = targets.find((t) => t.id === targetId) ?? null;
  // the PC folder follows the target (its first allowed folder) until the user types their own
  useEffect(() => { if (!cwdEdited) setCwd(defaultTargetFolder(project?.path ?? null, target?.allowed_roots ?? [])); }, [target, project, cwdEdited]);

  const adapter = adapterPick ?? (module ? 'debugpy' : program ? adapterFor(program) : 'js-debug');
  const noDap = target && !target.capabilities?.features?.includes('dap');
  const npmMode = adapter === 'js-debug' && runtime !== 'node';
  // editor breakpoints of this project, as paths relative to the PC folder
  const breakpoints = useMemo(() => {
    if (!project) return [];
    const map = { runtimeRoot: project.path, targetRoot: '.' };
    return Object.entries(store.breakpoints).flatMap(([path, lines]) => {
      const rel = toTargetPath(path, map)?.replace(/^\.\//, '');
      return rel && rel !== '.' ? lines.map((line) => ({ path: rel, line })) : [];
    });
  }, [store.breakpoints, project]);

  const start = async () => {
    if (!target) return;
    setError(null);
    try {
      if (sync && project) {
        setPhase('프로젝트를 PC로 복사하는 중…');
        await readApiJson(await api.targets.sync(target.id, project.path, { dest: cwd }));
      }
      setPhase(`${ADAPTERS.find((a) => a.id === adapter)?.label} 시작 중… (처음이면 어댑터를 내려받습니다)`);
      const launch: RemoteDebugLaunch = {
        adapter, cwd, args: splitArgs(args), stopOnEntry, breakpoints, waitSec: 0,
        ...(adapter === 'debugpy' && module ? { module } : {}),
        ...(npmMode ? { runtimeExecutable: runtime, runtimeArgs: splitArgs(runtimeArgs) } : {}),
        ...(program && !(adapter === 'debugpy' && module) ? { program } : {}),
      };
      const r = await readApiJson<{ session: RemoteDebugSnapshot }>(await debugApi.start(target.id, launch));
      if (project && r.session.cwd) debugStore.setMap(r.session.id, { runtimeRoot: project.path, targetRoot: r.session.cwd });
      debugStore.select(r.session.id);
      onStarted(r.session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase(null);
    }
  };

  const field = 'h-7 rounded border border-border bg-background px-2 text-xs';
  const ready = target?.online && !noDap && (program || (adapter === 'debugpy' && module) || npmMode);
  return (
    <div className="space-y-2 p-3 text-xs" data-testid="debug-start-form">
      <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground">PC</span>
        <select aria-label="원격 PC" value={targetId ?? ''} onChange={(e) => setTargetId(Number(e.target.value) || null)} className={field}>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (오프라인)'}{t.is_default ? ' · 기본' : ''}</option>)}
        </select>
        <span className="text-muted-foreground">프로그램</span>
        <input aria-label="프로그램" value={program} onChange={(e) => setProgram(e.target.value)} placeholder="src/index.js · main.py · target/debug/app (PC 폴더 기준)" className={field} />
        <span className="text-muted-foreground">디버거</span>
        <select aria-label="디버거" value={adapter} onChange={(e) => setAdapterPick(e.target.value as RemoteDebugAdapter)} className={field}>
          {ADAPTERS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        {adapter === 'js-debug' ? (
          <>
            <span className="text-muted-foreground">실행</span>
            <div className="flex gap-1.5">
              <select aria-label="실행 방식" value={runtime} onChange={(e) => setRuntime(e.target.value)} className={`${field} w-20`}>{RUNTIMES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
              {npmMode ? <input aria-label="실행 인자" value={runtimeArgs} onChange={(e) => setRuntimeArgs(e.target.value)} placeholder="test · run dev" className={`${field} min-w-0 flex-1`} /> : <span className="self-center text-muted-foreground">node &lt;프로그램&gt;</span>}
            </div>
          </>
        ) : null}
        {adapter === 'debugpy' ? (
          <>
            <span className="text-muted-foreground">모듈</span>
            <input aria-label="모듈" value={module} onChange={(e) => setModule(e.target.value)} placeholder="(선택) pytest · uvicorn — 프로그램 대신 python -m" className={field} />
          </>
        ) : null}
        <span className="text-muted-foreground">인자</span>
        <input aria-label="인자" value={args} onChange={(e) => setArgs(e.target.value)} placeholder='--port 3000 "a b"' className={field} />
        <span className="text-muted-foreground">PC 폴더</span>
        <input aria-label="PC 폴더" value={cwd} onChange={(e) => { setCwd(e.target.value); setCwdEdited(true); }} className={`${field} aidev-selectable`} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {project ? <label className="flex items-center gap-1.5"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 먼저 {project.name}을(를) PC 폴더로 복사</label> : null}
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={stopOnEntry} onChange={(e) => setStopOnEntry(e.target.checked)} /> 첫 줄에서 멈춤</label>
        <span className="text-muted-foreground">중단점 {breakpoints.length}개 (편집기 줄 번호 왼쪽을 눌러 추가)</span>
      </div>
      {noDap ? <div className="text-amber-600">이 PC의 러너({target?.capabilities?.runner ?? '?'})는 디버깅을 지원하지 않습니다 — aidev-runner 0.8.0 이상으로 교체하세요 (Mac: ops/runner/install.sh).</div> : null}
      {phase ? <div className="text-primary">{phase}</div> : null}
      {error ? <div className="aidev-selectable whitespace-pre-wrap text-red-600">{error}</div> : null}
      <div className="flex gap-1.5">
        <button type="button" disabled={!ready || Boolean(phase)} onClick={() => { void start(); }} className="inline-flex h-7 items-center gap-1 rounded bg-primary px-3 text-primary-foreground disabled:opacity-50"><Play size={12} /> 디버그 시작</button>
        {onCancel ? <button type="button" onClick={onCancel} className="h-7 rounded border border-border px-3 hover:bg-muted">취소</button> : null}
      </div>
    </div>
  );
}
