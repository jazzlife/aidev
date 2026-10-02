import { useEffect, useState } from 'react';
import { ChevronRight, Link2, Monitor } from 'lucide-react';

import { aidevApi } from '@/modules/aidev-router';
import { TopBar } from '@m/components/TopBar';
import { useGo, useOpener, useParent } from '@m/lib/nav';

type Target = { id: number; name: string; online: boolean; capabilities?: { os?: string; screen?: boolean; control?: boolean } | null };

/** "원격 제어" (the drawer's entry): pick a PC; it opens that PC's program windows and consoles (`/screen/:id`). */
export function ScreenPickScreen() {
  const go = useGo();
  useParent(useOpener('/'));
  const [targets, setTargets] = useState<Target[] | null>(null);
  useEffect(() => { aidevApi.targets().then((r) => setTargets(r.targets as unknown as Target[])).catch(() => setTargets([])); }, []);
  const sorted = [...(targets ?? [])].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return (
    <div className="m-app">
      <TopBar title="원격 제어" subtitle="PC를 고르세요" back />
      <main className="m-scroll flex-1 pb-8">
        {targets === null ? <div className="p-4 text-muted text-sm m-pulse">불러오는 중…</div> : null}
        <ul>
          {sorted.map((t) => (
            <li key={t.id} className="border-b border-line">
              <button type="button" disabled={!t.online} onClick={() => go(`/screen/${t.id}`)} className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-elevated disabled:opacity-50">
                <Monitor size={20} className={t.online ? 'text-ink' : 'text-muted'} />
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] truncate">{t.name}</div>
                  <div className="text-[12px] text-muted">{t.online ? `${t.capabilities?.screen ? '창·콘솔' : '콘솔'}${t.capabilities?.control ? ' · 제어' : ''}` : '오프라인'}</div>
                </div>
                {t.online ? <ChevronRight size={18} className="text-muted" /> : null}
              </button>
            </li>
          ))}
        </ul>
        {targets && !targets.some((t) => t.online) ? (
          <div className="p-6 text-center text-muted text-sm">
            {targets.length ? '온라인인 PC가 없습니다. 그 PC에서 러너가 실행 중인지 확인하세요.' : '등록된 PC가 없습니다.'}
            <button type="button" onClick={() => go('/pcs')} className="mx-auto mt-4 flex h-11 items-center gap-2 rounded-xl border border-line px-5 text-[15px]"><Link2 size={16} /> PC 연결</button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
