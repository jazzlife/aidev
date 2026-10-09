import { useEffect, useState } from 'react';
import { Camera, ChevronDown, ChevronRight } from 'lucide-react';

import { aidevApi, type RemoteRun } from '@/modules/aidev-router';
import { ImageViewer } from '@m/components/ImageViewer';
import { RemoteRunCard, runStatus } from '@m/components/RemoteRunCard';
import { useGo } from '@m/lib/nav';

const POLL_MS = 5000;

/** One capture the agent (or the user) took during the chat: the kept image (tap → full screen with pinch zoom), or what it showed. */
function SnapshotCard({ run }: { run: RemoteRun }) {
  const go = useGo();
  const [src, setSrc] = useState<string | null>(null);
  // the capture shown full screen for zooming
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!run.snapshot) return undefined;
    let url: string | null = null;
    aidevApi.remoteRunImage(run.id).then((u) => { url = u; setSrc(u); }).catch(() => setSrc(null));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [run.id, run.snapshot]);
  const what = run.artifacts?.device?.name ?? run.artifacts?.window?.title ?? run.artifacts?.window?.app ?? run.cmd ?? '';
  return (
    <div className="rounded-xl border border-line bg-surface p-3" data-testid="snapshot-card">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Camera size={13} /><span className="min-w-0 flex-1 truncate">{run.target_name ?? `대상 #${run.target_id}`} · {what}</span>
        <span className="whitespace-nowrap">{new Date(run.started_at).toLocaleTimeString()}</span>
      </div>
      {src ? <button type="button" aria-label="크게 보기" className="mt-2 block w-full" onClick={() => setZoomed(true)}><img src={src} alt={what} className="max-h-[50dvh] w-full rounded-lg object-contain" /></button> : null}
      {src && zoomed ? <ImageViewer src={src} alt={what} onClose={() => setZoomed(false)} /> : null}
      <button type="button" className="m-touch mt-2 text-[13px] text-accent" onClick={() => go(`/screen/${run.target_id}`)}>지금 화면 보기</button>
    </div>
  );
}

/**
 * Used by ChatScreen (F-12): what this chat ran on the user's PCs — result cards for commands and the
 * screenshots taken — so a session started on the workbench shows its outcome on the phone too. Folded
 * into one summary line by default so the cards never crowd out the conversation; a tap opens them.
 */
export function SessionResults({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const [runs, setRuns] = useState<RemoteRun[]>([]);
  // the result cards are opened by the user; folded they leave the chat readable
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = () => { aidevApi.sessionRemoteRuns(sessionId, 12).then((r) => { if (!stopped) setRuns(r.runs); }).catch(() => {}); };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [sessionId, refreshKey]);
  const shown = runs.filter((run) => run.kind === 'exec' || run.kind === 'screenshot').slice(0, 6).reverse();
  if (!shown.length) return null;
  const latest = shown[shown.length - 1];
  const status = latest.kind === 'screenshot' ? { label: '화면 캡처', tone: 'text-muted' } : runStatus(latest);
  return (
    <section className="space-y-2 px-4 py-2" data-testid="session-results">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="m-touch flex w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 text-left text-[13px]">
        {open ? <ChevronDown size={15} className="shrink-0 text-muted" /> : <ChevronRight size={15} className="shrink-0 text-muted" />}
        <span className="shrink-0 text-muted">원격 실행 {shown.length}건</span>
        <code className="min-w-0 flex-1 truncate">{latest.cmd ?? ''}</code>
        <span className={`shrink-0 whitespace-nowrap font-medium ${status.tone}`}>{status.label}</span>
      </button>
      {open ? shown.map((run) => (run.kind === 'screenshot' ? <SnapshotCard key={run.id} run={run} /> : <RemoteRunCard key={run.id} run={run} lines={6} />)) : null}
    </section>
  );
}
