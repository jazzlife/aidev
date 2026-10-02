import { useEffect, useState } from 'react';
import { AppWindow, Bug, Link2, Monitor, MonitorSmartphone } from 'lucide-react';

import { aidevApi } from '@/modules/aidev-router';
import { BottomSheet } from '@m/components/BottomSheet';
import { useGo } from '@m/lib/nav';

/**
 * The phone's way to the user's PCs (F-06/F-07/F-09): a top-bar button that opens a sheet with the previews, the debugger
 * and, per online PC, its program windows and consoles (live screen, control when allowed).
 */
type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean; control?: boolean } | null };

/** Used by the sessions and chat screens' top bars. */
export function RemoteMenu() {
  const navigate = useGo();
  // sheet open/closed; the PC list is (re)loaded each time it opens (online state changes)
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  useEffect(() => {
    if (!open) return;
    aidevApi.targets().then((r) => setTargets(r.targets as unknown as Target[])).catch(() => setTargets([]));
  }, [open]);
  const go = (path: string) => { setOpen(false); navigate(path); };
  const row = 'w-full h-12 rounded-xl flex items-center gap-3 px-3 text-[15px] active:bg-elevated disabled:opacity-50';
  return (
    <>
      <button type="button" aria-label="원격 PC · 미리보기" onClick={() => setOpen(true)} className="m-touch flex items-center justify-center rounded-full text-muted"><MonitorSmartphone size={20} /></button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="원격 PC">
        <button type="button" className={row} onClick={() => go('/preview')}><AppWindow size={19} className="text-accent" /> 미리보기 <span className="ml-auto text-[12px] text-muted">개발 서버 열기·시작</span></button>
        <button type="button" className={row} onClick={() => go('/debug')}><Bug size={19} className="text-accent" /> 디버그 <span className="ml-auto text-[12px] text-muted">중단점·변수·한 줄 실행</span></button>
        {targets === null ? <div className="px-3 py-2 text-[13px] text-muted m-pulse">PC 목록을 불러오는 중…</div> : null}
        {targets?.map((t) => (
          <button key={t.id} type="button" disabled={!t.online} className={row} onClick={() => go(`/screen/${t.id}`)}>
            <Monitor size={19} className={t.online ? 'text-ink' : 'text-muted'} /> {t.name}
            <span className="ml-auto text-[12px] text-muted">{t.online ? `${t.capabilities?.screen ? '창·콘솔' : '콘솔'}${t.capabilities?.control ? ' · 제어' : ''}` : '오프라인'}</span>
          </button>
        ))}
        {targets && !targets.length ? <div className="px-3 py-2 text-[13px] text-muted">등록된 PC가 없습니다.</div> : null}
        <button type="button" className={row} onClick={() => go('/pcs')}><Link2 size={19} className="text-accent" /> PC 연결 <span className="ml-auto text-[12px] text-muted">등록·페어링·관리</span></button>
      </BottomSheet>
    </>
  );
}
