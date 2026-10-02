import { useEffect, useState } from 'react';

import { aidevApi } from '@/modules/aidev-router';
import { useGo } from '@m/lib/nav';

/**
 * Remote PC programs on the phone (IMPLEMENTATION-PLAN §3.12, F-07b/F-07c): one button per online PC; it
 * opens `/m/screen/:id` — its program windows (when the owner allowed screen access: snapshot first, live
 * stream and control on demand) and the consoles of commands running there through the runner.
 */
type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean; control?: boolean } | null };

/** Used by the mobile settings screen ("원격 PC 화면"). */
export function ScreenSnapshotSection() {
  const go = useGo();
  const [targets, setTargets] = useState<Target[] | null>(null);
  useEffect(() => { aidevApi.targets().then((r) => setTargets(r.targets as unknown as Target[])).catch(() => setTargets([])); }, []);
  // consoles need no screen consent, so every online PC is worth a button
  const usable = (targets ?? []).filter((t) => t.online);
  if (!targets || !targets.length) return null;
  return (
    <section data-testid="screen-snapshots">
      <div className="mb-2 text-[12px] uppercase tracking-wide text-muted">원격 PC 프로그램</div>
      {usable.length ? (
        <div className="flex flex-wrap gap-2">{usable.map((t) => <button key={t.id} type="button" onClick={() => go(`/screen/${t.id}`)} className="m-touch rounded-xl2 border border-line bg-surface px-4 py-2 text-[14px]">{t.name} {t.capabilities?.screen ? '창·콘솔' : '콘솔'}{t.capabilities?.control ? ' · 제어' : ''}</button>)}</div>
      ) : (
        <div className="rounded-xl2 border border-line bg-surface px-4 py-3 text-[14px] text-muted">온라인인 PC가 없습니다. 프로그램 창을 보려면 그 PC에서 <code>aidev-runner consent screen on</code>(제어까지는 <code>consent control on</code>) 후 러너를 다시 시작하세요.</div>
      )}
    </section>
  );
}
