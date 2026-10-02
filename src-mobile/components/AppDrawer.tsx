import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppWindow, Bot, Bug, FolderGit2, Link2, MessageSquare, Monitor, Plus, Settings, Star, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';

import { api, useAuth } from '@/modules/chat-core';
import { aidevApi } from '@/modules/aidev-router';
import { useBackOverlay, useGo } from '@m/lib/nav';

/**
 * The app's common menu (2026-10-02, "공통 메뉴와 프로젝트 선택은 드로어에서 바로"): conversations, a project switch, the
 * remote tools (remote control, preview, debugger, PC pairing), the agent catalog and settings — fixed entries only
 * (which PC is chosen on the screen it opens; run history lives in its conversation) — reachable from
 * every screen (☰ in the top bar, or a swipe from the left edge). Top bars keep only the page's own actions.
 */
type DrawerApi = { open: () => void };
const DrawerContext = createContext<DrawerApi>({ open: () => undefined });

/** Used by TopBar for its ☰ button. */
export function useDrawer() {
  return useContext(DrawerContext);
}

type Project = { projectId: string; displayName: string; fullPath: string; isStarred?: boolean; sessions?: Array<{ lastActivity?: string }> };
type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean } | null };
const latest = (p: Project) => p.sessions?.reduce((max, s) => (s.lastActivity && s.lastActivity > max ? s.lastActivity : max), '') ?? '';
const EDGE_PX = 24;
const SWIPE_PX = 60;

function Drawer({ onClose }: { onClose: () => void }) {
  const go = useGo();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [targets, setTargets] = useState<Target[] | null>(null);
  useBackOverlay(true, onClose);
  useEffect(() => {
    api.projects().then(async (r) => {
      const data = await r.json() as Project[];
      const list = Array.isArray(data) ? data : [];
      list.sort((a, b) => Number(Boolean(b.isStarred)) - Number(Boolean(a.isStarred)) || latest(b).localeCompare(latest(a)));
      setProjects(list);
    }).catch(() => setProjects([]));
    aidevApi.targets().then((r) => setTargets(r.targets as unknown as Target[])).catch(() => setTargets([]));
  }, []);
  const open = (path: string) => { onClose(); go(path); };
  const row = (active: boolean) => `w-full h-11 rounded-xl flex items-center gap-3 px-3 text-[15px] text-left ${active ? 'bg-elevated font-medium' : 'active:bg-elevated'}`;
  const section = (title: string) => <div className="px-3 pt-4 pb-1 text-[11px] uppercase tracking-wide text-muted">{title}</div>;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="메뉴" data-testid="app-drawer">
      <button type="button" aria-label="메뉴 닫기" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <nav className="absolute left-0 top-0 bottom-0 w-[84vw] max-w-[340px] flex flex-col bg-surface border-r border-line shadow-2xl pt-safe-t pb-safe-b">
        <div className="flex items-center gap-3 px-4 h-14 border-b border-line">
          <img src="/logo-64.png" alt="" className="h-8 w-8 rounded-full" />
          <div className="flex-1 min-w-0"><div className="text-[15px] font-semibold">NadoVibe</div><div className="text-[12px] text-muted truncate">{user?.username ?? ''}</div></div>
          <button type="button" aria-label="닫기" onClick={onClose} className="m-touch flex items-center justify-center rounded-full text-muted"><X size={20} /></button>
        </div>
        <div className="m-scroll flex-1 px-2 pb-4">
          {section('대화')}
          <button type="button" className={row(pathname === '/')} onClick={() => open('/')}><MessageSquare size={18} className="text-muted" /> 대화 목록</button>
          <button type="button" className={row(pathname === '/new')} onClick={() => open('/new')}><Plus size={18} className="text-accent" /> 새 대화</button>

          {section('프로젝트')}
          {projects === null ? <div className="px-3 py-2 text-[13px] text-muted m-pulse">불러오는 중…</div> : null}
          {projects?.slice(0, 8).map((p) => {
            const path = `/projects/${encodeURIComponent(p.projectId)}`;
            return (
              <button key={p.projectId} type="button" className={row(pathname === path)} onClick={() => open(path)}>
                <FolderGit2 size={18} className="text-muted shrink-0" />
                <span className="flex-1 min-w-0 truncate">{p.displayName}</span>
                {p.isStarred ? <Star size={12} className="text-accent shrink-0" fill="currentColor" /> : null}
              </button>
            );
          })}
          {projects && projects.length === 0 ? <div className="px-3 py-2 text-[13px] text-muted">프로젝트가 없습니다</div> : null}
          <button type="button" className={`${row(pathname === '/projects')} text-accent`} onClick={() => open('/projects')}>모든 프로젝트{projects && projects.length > 8 ? ` (${projects.length})` : ''}</button>

          {section('원격 PC')}
          <button type="button" className={row(pathname.startsWith('/screen'))} onClick={() => open('/screen')}><Monitor size={18} className="text-muted" /> 원격 제어</button>
          <button type="button" className={row(pathname === '/preview')} onClick={() => open('/preview')}><AppWindow size={18} className="text-muted" /> 미리보기</button>
          <button type="button" className={row(pathname === '/debug')} onClick={() => open('/debug')}><Bug size={18} className="text-muted" /> 디버그</button>
          <button type="button" className={row(pathname === '/pcs')} onClick={() => open('/pcs')}>
            <Link2 size={18} className="text-muted" /> <span className="flex-1">PC 연결</span>
            {targets ? <span className="text-[12px] text-muted">{targets.filter((t) => t.online).length}/{targets.length}</span> : null}
          </button>

          {section('기타')}
          <button type="button" className={row(pathname.startsWith('/catalog'))} onClick={() => open('/catalog')}><Bot size={18} className="text-muted" /> Agent 카탈로그</button>
          <button type="button" className={row(pathname === '/settings')} onClick={() => open('/settings')}><Settings size={18} className="text-muted" /> 설정</button>
        </div>
      </nav>
    </div>
  );
}

/** Mounted once around the signed-in screens: the drawer and the swipe from the left edge that opens it. */
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const down = (e: TouchEvent) => { const t = e.touches[0]; start = t && t.clientX <= EDGE_PX ? { x: t.clientX, y: t.clientY } : null; };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (start && t && t.clientX - start.x > SWIPE_PX && Math.abs(t.clientY - start.y) < SWIPE_PX) setOpen(true);
      start = null;
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    return () => { document.removeEventListener('touchstart', down); document.removeEventListener('touchend', up); };
  }, []);
  const value = useMemo(() => ({ open }), [open]);
  return <DrawerContext.Provider value={value}>{children}{isOpen ? <Drawer onClose={close} /> : null}</DrawerContext.Provider>;
}
