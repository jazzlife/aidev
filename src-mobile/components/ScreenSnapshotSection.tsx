import { useCallback, useEffect, useState } from 'react';

import { aidevApi } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';

/**
 * Remote PC screens on the phone (IMPLEMENTATION-PLAN §3.12, F-07): a snapshot per tap instead of a live
 * stream (data and battery). Only PCs whose owner allowed capture (`aidev-runner consent screen on`).
 */
type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean } | null };

/** Used by the mobile settings screen ("원격 PC 화면"). */
export function ScreenSnapshotSection() {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [open, setOpen] = useState<Target | null>(null);
  const [shot, setShot] = useState<{ src: string; width: number; height: number; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { aidevApi.targets().then((r) => setTargets(r.targets as unknown as Target[])).catch(() => setTargets([])); }, []);
  const take = useCallback(async (t: Target) => {
    setBusy(true); setError(null);
    try {
      const r = await aidevApi.screenshot(t.id, { maxWidth: 1280 });
      setShot({ src: `data:${r.mime};base64,${r.image}`, width: r.width, height: r.height, at: Date.now() });
    } catch (e) { setError(e instanceof Error ? e.message : '화면을 가져오지 못했습니다'); }
    finally { setBusy(false); }
  }, []);
  const show = (t: Target) => { setOpen(t); setShot(null); void take(t); };
  const usable = (targets ?? []).filter((t) => t.online && t.capabilities?.screen);

  if (!targets || !targets.length) return null;
  return (
    <section data-testid="screen-snapshots">
      <div className="mb-2 text-[12px] uppercase tracking-wide text-muted">원격 PC 화면</div>
      {usable.length ? (
        <div className="flex flex-wrap gap-2">{usable.map((t) => <button key={t.id} type="button" onClick={() => show(t)} className="m-touch rounded-xl2 border border-line bg-surface px-4 py-2 text-[14px]">{t.name} 화면 보기</button>)}</div>
      ) : (
        <div className="rounded-xl2 border border-line bg-surface px-4 py-3 text-[14px] text-muted">화면을 볼 수 있는 PC가 없습니다. PC가 온라인이고, 그 PC에서 <code>aidev-runner consent screen on</code> 후 러너를 다시 시작해야 합니다.</div>
      )}
      <BottomSheet open={Boolean(open)} onClose={() => setOpen(null)} title={open ? `${open.name} 화면` : ''}>
        {shot ? <img src={shot.src} alt={`${open?.name ?? ''} 화면`} className="w-full rounded-lg border border-line" /> : null}
        {!shot && busy ? <div className="py-8 text-center text-muted">화면을 가져오는 중…</div> : null}
        {error ? <div className="py-2 text-[13px] text-danger">{error}</div> : null}
        <div className="mt-3 flex items-center gap-3">
          <button type="button" disabled={busy || !open} onClick={() => { if (open) void take(open); }} className="m-touch rounded-full bg-accent px-4 py-2 text-[14px] text-accent-ink disabled:opacity-50">{busy ? '가져오는 중…' : '다시 찍기'}</button>
          {shot ? <span className="text-[12px] text-muted">{shot.width}×{shot.height} · {new Date(shot.at).toLocaleTimeString()}</span> : null}
        </div>
      </BottomSheet>
    </section>
  );
}
