import { useCallback, useEffect, useState } from 'react';
import { Play, RefreshCw } from 'lucide-react';

import { api, readApiJson } from '@/modules/chat-core';
import { aidevApi, type RemoteRun } from '@/modules/aidev-router';
import { RemoteRunCard } from '@m/components/RemoteRunCard';
import { TopBar } from '@m/components/TopBar';
import { useOpener, useParent } from '@m/lib/nav';

type Target = { id: number; name: string; online: boolean; allowed_roots?: string[] };

/**
 * "원격 실행" (the workbench's run pane, for phones): run a command on one of the user's PCs and follow the latest runs —
 * the user's own and the agents' — as live result cards (output, exit code, stop).
 */
export function RunsScreen() {
  useParent(useOpener('/'));
  const [runs, setRuns] = useState<RemoteRun[] | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [cmd, setCmd] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    aidevApi.remoteRuns(40).then((r) => setRuns(r.runs)).catch((e: Error) => setNote(e.message));
  }, []);
  useEffect(() => {
    load();
    aidevApi.targets().then((r) => {
      const list = r.targets as unknown as Target[];
      setTargets(list);
      setTargetId((current) => current ?? list.find((t) => t.online)?.id ?? null);
    }).catch(() => setTargets([]));
  }, [load]);

  const run = async () => {
    if (!targetId || !cmd.trim()) return;
    setBusy(true); setNote(null);
    try {
      await readApiJson(await api.targets.exec(targetId, { cmd: cmd.trim(), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }));
      setCmd('');
      load();
    } catch (error) {
      setNote(error instanceof Error ? error.message : '실행하지 못했습니다');
    } finally {
      setBusy(false);
    }
  };
  const online = targets.filter((t) => t.online);
  const target = targets.find((t) => t.id === targetId);

  return (
    <div className="m-app">
      <TopBar title="원격 실행" subtitle={runs ? `최근 ${runs.length}건` : undefined} back
        right={<button type="button" aria-label="새로고침" onClick={load} className="m-touch flex items-center justify-center rounded-full text-muted"><RefreshCw size={19} /></button>} />
      <main className="m-scroll flex-1 px-3 pb-8 space-y-3">
        <section className="mt-3 rounded-xl2 border border-line bg-surface p-3" data-testid="run-form">
          {online.length === 0 ? <div className="text-[13px] text-muted">온라인인 PC가 없습니다. 메뉴의 "PC 연결"에서 PC를 등록하고 러너를 실행하세요.</div> : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {online.map((t) => (
                  <button key={t.id} type="button" aria-pressed={t.id === targetId} onClick={() => setTargetId(t.id)} className={`m-touch rounded-full px-3 text-[13px] ${t.id === targetId ? 'bg-ink text-bg' : 'border border-line'}`}>{t.name}</button>
                ))}
              </div>
              <input value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } }} placeholder="명령 (예: npm test, git status)" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                className="mt-2 w-full h-11 rounded-xl border border-line bg-bg px-3 font-mono text-[14px]" />
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={`폴더 (기본: ${target?.allowed_roots?.[0] ?? '첫 허용 폴더'})`} autoCapitalize="off" autoCorrect="off" spellCheck={false}
                className="mt-2 w-full h-10 rounded-xl border border-line bg-bg px-3 font-mono text-[12px]" />
              <button type="button" disabled={busy || !cmd.trim() || !targetId} onClick={() => { void run(); }} className="mt-2 w-full h-11 rounded-xl bg-accent text-accent-ink text-[15px] font-medium flex items-center justify-center gap-2 disabled:opacity-50">
                <Play size={16} /> {busy ? '시작하는 중…' : `${target?.name ?? 'PC'}에서 실행`}
              </button>
            </>
          )}
          {note ? <div className="mt-2 text-[12px] text-danger">{note}</div> : null}
        </section>
        {runs === null ? <div className="text-muted text-sm m-pulse">불러오는 중…</div> : null}
        {runs && runs.length === 0 ? <div className="text-center text-muted text-sm py-6">아직 원격 PC에서 실행한 명령이 없습니다.</div> : null}
        {(runs ?? []).filter((r) => r.kind !== 'screenshot' && r.kind !== 'control').map((r) => <RemoteRunCard key={r.id} run={r} lines={8} />)}
      </main>
    </div>
  );
}
