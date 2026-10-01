import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera } from 'lucide-react';

import { aidevApi, type RemoteRun } from '@/modules/aidev-router';
import { ImageViewer } from '@m/components/ImageViewer';
import { RemoteRunCard } from '@m/components/RemoteRunCard';

const POLL_MS = 5000;

/** One capture the agent (or the user) took during the chat: the kept image (tap → full screen with pinch zoom), or what it showed. */
function SnapshotCard({ run }: { run: RemoteRun }) {
  const navigate = useNavigate();
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
      <button type="button" className="m-touch mt-2 text-[13px] text-accent" onClick={() => navigate(`/screen/${run.target_id}`)}>지금 화면 보기</button>
    </div>
  );
}

/**
 * Used by ChatScreen (F-12): what this chat ran on the user's PCs — result cards for commands and the
 * screenshots taken — so a session started on the workbench shows its outcome on the phone too.
 */
export function SessionResults({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const [runs, setRuns] = useState<RemoteRun[]>([]);
  useEffect(() => {
    let stopped = false;
    const load = () => { aidevApi.sessionRemoteRuns(sessionId, 12).then((r) => { if (!stopped) setRuns(r.runs); }).catch(() => {}); };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [sessionId, refreshKey]);
  const shown = runs.filter((run) => run.kind === 'exec' || run.kind === 'screenshot').slice(0, 6).reverse();
  if (!shown.length) return null;
  return (
    <section className="space-y-2 px-4 py-2" data-testid="session-results">
      <div className="text-[12px] uppercase tracking-wide text-muted">이 대화의 원격 실행</div>
      {shown.map((run) => (run.kind === 'screenshot' ? <SnapshotCard key={run.id} run={run} /> : <RemoteRunCard key={run.id} run={run} lines={6} />))}
    </section>
  );
}
