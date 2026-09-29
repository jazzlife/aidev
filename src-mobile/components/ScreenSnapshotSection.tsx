import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { aidevApi } from '@/modules/aidev-router';

/**
 * Remote PC screens on the phone (IMPLEMENTATION-PLAN §3.12, F-07b): one button per PC whose owner allowed
 * screen access; it opens `/m/screen/:id` (snapshot first, live stream and control on demand).
 */
type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean; control?: boolean } | null };

/** Used by the mobile settings screen ("원격 PC 화면"). */
export function ScreenSnapshotSection() {
  const navigate = useNavigate();
  const [targets, setTargets] = useState<Target[] | null>(null);
  useEffect(() => { aidevApi.targets().then((r) => setTargets(r.targets as unknown as Target[])).catch(() => setTargets([])); }, []);
  const usable = (targets ?? []).filter((t) => t.online && t.capabilities?.screen);
  if (!targets || !targets.length) return null;
  return (
    <section data-testid="screen-snapshots">
      <div className="mb-2 text-[12px] uppercase tracking-wide text-muted">원격 PC 화면</div>
      {usable.length ? (
        <div className="flex flex-wrap gap-2">{usable.map((t) => <button key={t.id} type="button" onClick={() => navigate(`/screen/${t.id}`)} className="m-touch rounded-xl2 border border-line bg-surface px-4 py-2 text-[14px]">{t.name} 화면{t.capabilities?.control ? ' · 제어' : ''}</button>)}</div>
      ) : (
        <div className="rounded-xl2 border border-line bg-surface px-4 py-3 text-[14px] text-muted">화면을 볼 수 있는 PC가 없습니다. PC가 온라인이고, 그 PC에서 <code>aidev-runner consent screen on</code>(제어까지는 <code>consent control on</code>) 후 러너를 다시 시작해야 합니다.</div>
      )}
    </section>
  );
}
