import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, GitBranch, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { DiffPeek } from '@m/components/DiffPeek';
import { failureText } from '@m/lib/http';
import { fileEditFromUnifiedDiff, type FileEdit } from '@m/lib/peek';

type Status = { branch?: string; modified?: string[]; added?: string[]; deleted?: string[]; untracked?: string[]; staged?: string[]; error?: string; details?: string; notGitRepository?: boolean };
type Remote = { hasRemote?: boolean; hasUpstream?: boolean; ahead?: number; behind?: number; remoteBranch?: string; error?: string };
type Change = { path: string; kind: 'M' | 'A' | 'D' | 'U' };

const KIND_STYLE: Record<Change['kind'], string> = { M: 'text-warn', A: 'text-ok', D: 'text-danger', U: 'text-ok' };
const KIND_LABEL: Record<Change['kind'], string> = { M: '수정', A: '추가', D: '삭제', U: '새 파일' };

export function changesOf(status: Status): Change[] {
  return [
    ...(status.modified ?? []).map((path): Change => ({ path, kind: 'M' })),
    ...(status.added ?? []).map((path): Change => ({ path, kind: 'A' })),
    ...(status.deleted ?? []).map((path): Change => ({ path, kind: 'D' })),
    ...(status.untracked ?? []).map((path): Change => ({ path, kind: 'U' })),
  ];
}

/** Calls a git route: the server's words when it fails (some answer 200 with `error`). */
async function gitCall<T extends { error?: string; details?: string }>(request: Promise<Response>): Promise<T> {
  const response = await request;
  if (!response.ok) throw new Error(await failureText(response));
  const body = await response.json().catch(() => ({})) as T;
  if (body.error) throw new Error(body.details || body.error);
  return body;
}

/**
 * Used by the project screen (top bar) and the chat's conversation sheet ("변경 사항"): the project's working tree on
 * the runtime — branch and how far ahead or behind, the changed files (checked ones go into the commit; a tap shows
 * the diff), a commit message (✨ asks the agent for one), commit, then pull or push. Throwing away a file's changes
 * asks first. Failures show the server's own words.
 */
export function GitSheet({ open, onClose, project, provider }: { open: boolean; onClose: () => void; project: { projectId: string; displayName: string } | null; provider: string }) {
  // the working tree and the remote as last read (null: loading)
  const [status, setStatus] = useState<Status | null>(null);
  const [remote, setRemote] = useState<Remote | null>(null);
  // the files left out of the next commit (all go in by default)
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  // the commit message being written
  const [message, setMessage] = useState('');
  // what is running (one action at a time), what failed, and what just succeeded
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // the file whose changes are about to be thrown away (confirmation)
  const [discarding, setDiscarding] = useState<Change | null>(null);
  // the diff on show
  const [diff, setDiff] = useState<FileEdit | null>(null);
  const id = project?.projectId ?? '';

  const load = useCallback(async () => {
    if (!id) return;
    const statusBody = await api.git.status(id).then((r) => r.json() as Promise<Status>).catch((): Status => ({ error: '상태를 읽지 못했습니다' }));
    setStatus(statusBody);
    if (!statusBody.error) setRemote(await api.git.remoteStatus(id).then((r) => r.json() as Promise<Remote>).catch(() => null));
  }, [id]);
  useEffect(() => {
    if (!open) return;
    setStatus(null); setRemote(null); setExcluded(new Set()); setError(null); setNotice(null); setDiscarding(null);
    void load();
  }, [open, load]);

  const run = async (label: string, action: () => Promise<string | void>) => {
    setBusy(label); setError(null); setNotice(null);
    try { const done = await action(); if (done) setNotice(done); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '실패했습니다'); }
    finally { setBusy(null); }
  };
  const changes = status ? changesOf(status) : [];
  const included = changes.filter((c) => !excluded.has(c.path)).map((c) => c.path);
  const toggle = (path: string) => setExcluded((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const showDiff = async (change: Change) => {
    try {
      const body = await gitCall<{ diff?: string; error?: string }>(api.git.diff(id, change.path));
      setDiff(fileEditFromUnifiedDiff(change.path, body.diff ?? '', { created: change.kind === 'U' || change.kind === 'A', deleted: change.kind === 'D' }));
    } catch (err) { setError(err instanceof Error ? err.message : 'diff를 읽지 못했습니다'); }
  };
  const generate = () => run('message', async () => {
    const body = await gitCall<{ message?: string; error?: string }>(api.git.generateCommitMessage(id, included, provider === 'cursor' ? 'cursor' : 'claude'));
    if (body.message) setMessage(body.message.trim());
  });
  const commit = () => run('commit', async () => {
    await gitCall(api.git.commit(id, message.trim(), included));
    setMessage(''); setExcluded(new Set());
    return '커밋했습니다';
  });

  const ahead = remote?.ahead ?? 0;
  const behind = remote?.behind ?? 0;
  return (
    <BottomSheet open={open} onClose={onClose} title={<span className="flex items-center gap-2"><GitBranch size={16} /> 변경 사항{project ? <span className="truncate text-[13px] font-normal text-muted">· {project.displayName}</span> : null}</span>}>
      <div className="space-y-3" data-testid="git-sheet">
        {status === null ? <div className="text-[13px] text-muted m-pulse">읽는 중…</div> : null}
        {status?.notGitRepository ? (
          <div className="space-y-2">
            <p className="text-[14px] text-muted">이 프로젝트는 git 저장소가 아닙니다.</p>
            <button type="button" disabled={busy !== null} onClick={() => { void run('init', async () => { await gitCall(api.git.init(id)); return 'git 저장소를 만들었습니다'; }); }} className="h-11 w-full rounded-xl border border-line text-[15px]">git init</button>
          </div>
        ) : status?.error ? <div className="text-[13px] text-danger">{status.details || status.error}</div> : null}
        {status && !status.error ? (
          <>
            <div className="flex items-center gap-2 text-[13px]">
              <GitBranch size={15} className="shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate font-mono">{status.branch}</span>
              {remote?.hasUpstream ? <span className="shrink-0 text-muted" data-testid="git-ahead-behind">↑{ahead} ↓{behind}</span> : remote?.hasRemote === false ? <span className="shrink-0 text-muted">원격 없음</span> : null}
              <button type="button" aria-label="원격 새로 읽기" disabled={busy !== null} onClick={() => { void run('fetch', async () => { await gitCall(api.git.fetch(id)); }); }} className="m-touch -my-2 flex shrink-0 items-center justify-center text-muted"><RefreshCw size={15} className={busy === 'fetch' ? 'animate-spin' : ''} /></button>
            </div>
            {changes.length === 0 ? <div className="rounded-xl bg-elevated px-3 py-2 text-[13px] text-muted">바뀐 파일이 없습니다</div> : (
              <ul className="max-h-[34dvh] overflow-y-auto rounded-xl border border-line" data-testid="git-files">
                {changes.map((change) => (
                  <li key={change.path} className="flex items-center border-b border-line last:border-b-0">
                    <button type="button" role="checkbox" aria-checked={!excluded.has(change.path)} aria-label={`${change.path} 커밋에 넣기`} onClick={() => toggle(change.path)} className="m-touch flex shrink-0 items-center justify-center">
                      <span className={`flex h-5 w-5 items-center justify-center rounded border ${excluded.has(change.path) ? 'border-line' : 'border-accent bg-accent text-accent-ink'}`}>{excluded.has(change.path) ? null : <Check size={13} />}</span>
                    </button>
                    <button type="button" onClick={() => { void showDiff(change); }} className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left">
                      <span className={`w-10 shrink-0 text-[11px] ${KIND_STYLE[change.kind]}`}>{KIND_LABEL[change.kind]}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{change.path}</span>
                    </button>
                    <button type="button" aria-label={`${change.path} 변경 버리기`} onClick={() => setDiscarding(change)} className="m-touch flex shrink-0 items-center justify-center text-muted"><RotateCcw size={15} /></button>
                  </li>
                ))}
              </ul>
            )}
            {discarding ? (
              <div className="space-y-2 rounded-xl border border-danger/40 bg-danger/5 p-3" role="alertdialog">
                <p className="text-[14px]">{discarding.kind === 'U' ? '새 파일을 지웁니다' : '이 파일의 변경을 버립니다'}: <code className="break-all text-[12px]">{discarding.path}</code> · 되돌릴 수 없습니다.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDiscarding(null)} className="h-10 flex-1 rounded-lg border border-line text-[14px]">취소</button>
                  <button type="button" disabled={busy !== null} onClick={() => { const target = discarding; setDiscarding(null); void run('discard', async () => { await gitCall(target.kind === 'U' ? api.git.deleteUntracked(id, target.path) : api.git.discard(id, target.path)); }); }}
                    className="h-10 flex-1 rounded-lg bg-danger text-[14px] font-medium text-white">{discarding.kind === 'U' ? '파일 지우기' : '변경 버리기'}</button>
                </div>
              </div>
            ) : null}
            {changes.length ? (
              <div className="space-y-2">
                <div className="relative">
                  <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="커밋 메시지" aria-label="커밋 메시지" className="w-full resize-none rounded-xl border border-line bg-bg px-3 py-2 pr-11 text-[15px] outline-none focus:border-accent" />
                  <button type="button" aria-label="커밋 메시지 만들기" disabled={busy !== null || !included.length} onClick={() => { void generate(); }} className="absolute right-1 top-1 m-touch flex items-center justify-center text-accent disabled:opacity-40"><Sparkles size={17} className={busy === 'message' ? 'm-pulse' : ''} /></button>
                </div>
                <button type="button" disabled={busy !== null || !message.trim() || !included.length} onClick={() => { void commit(); }} className="h-11 w-full rounded-xl bg-accent text-[15px] font-medium text-accent-ink disabled:opacity-40">{busy === 'commit' ? '커밋 중…' : `커밋 (${included.length}개 파일)`}</button>
              </div>
            ) : null}
            {remote?.hasRemote ? (
              <div className="flex gap-2">
                <button type="button" disabled={busy !== null} onClick={() => { void run('pull', async () => { await gitCall(api.git.pull(id)); return '당겨왔습니다'; }); }} className="flex h-10 flex-1 items-center justify-center gap-1 rounded-xl border border-line text-[14px] disabled:opacity-40"><ArrowDown size={15} /> 당겨오기{behind ? ` ${behind}` : ''}</button>
                <button type="button" disabled={busy !== null} onClick={() => { void run('push', async () => { await gitCall(api.git.push(id)); return '푸시했습니다'; }); }} className={`flex h-10 flex-1 items-center justify-center gap-1 rounded-xl text-[14px] disabled:opacity-40 ${ahead ? 'bg-accent font-medium text-accent-ink' : 'border border-line'}`}><ArrowUp size={15} /> 푸시{ahead ? ` ${ahead}` : ''}</button>
              </div>
            ) : null}
          </>
        ) : null}
        {notice ? <div className="text-[13px] text-ok" role="status">{notice}</div> : null}
        {error ? <div className="whitespace-pre-wrap text-[13px] text-danger" role="alert">{error}</div> : null}
      </div>
      <DiffPeek edit={diff} onClose={() => setDiff(null)} />
    </BottomSheet>
  );
}
