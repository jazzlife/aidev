import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppWindow, Bot, Bug, FolderGit2, Link2, MessageSquare, Monitor, Settings, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';

import { useAuth } from '@/modules/chat-core';
import { aidevApi } from '@/modules/aidev-router';
import { useBackOverlay, useGo } from '@m/lib/nav';
import { useCurrentConversation, useCurrentProject } from '@m/lib/current';
import { useRunningSessions } from '@m/lib/runningSessions';
import { useWorkspacesRoot } from '@/shared/hooks/useWorkspacesRoot';
import { collapseWorkspacesRoot } from '@/shared/utils';

/**
 * The app's common menu, reachable from every screen (☰ in the top bar, or a swipe from the left edge). No lists here
 * (C-12.1): "현재 작업" — the project a new conversation starts in and the conversation last opened (running or not) —
 * then the remote tools (remote control, preview, debugger, PC pairing), the agent catalog and settings. Projects and
 * conversations are listed on the home tabs. Top bars keep only the page's own actions.
 */
type DrawerApi = { open: () => void };
const DrawerContext = createContext<DrawerApi>({ open: () => undefined });

/** Used by TopBar for its ☰ button. */
export function useDrawer() {
  return useContext(DrawerContext);
}

type Target = { id: number; name: string; online: boolean; capabilities?: { screen?: boolean } | null };
const EDGE_PX = 24;
const SWIPE_PX = 60;

function Drawer({ onClose }: { onClose: () => void }) {
  const go = useGo();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const project = useCurrentProject();
  const conversation = useCurrentConversation();
  const [targets, setTargets] = useState<Target[] | null>(null);
  const running = useRunningSessions();
  // project paths print as ~/… under the projects home
  const workspacesRoot = useWorkspacesRoot();
  useBackOverlay(true, onClose);
  useEffect(() => {
    aidevApi.targets().then((r) => setTargets(r.targets as unknown as Target[])).catch(() => setTargets([]));
  }, []);
  const open = (path: string) => { onClose(); go(path); };
  const row = (active: boolean) => `w-full h-11 rounded-xl flex items-center gap-3 px-3 text-[15px] text-left ${active ? 'bg-elevated font-medium' : 'active:bg-elevated'}`;
  const section = (title: string) => <div className="px-3 pt-4 pb-1 text-[11px] uppercase tracking-wide text-muted">{title}</div>;
  const card = 'w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-left active:bg-elevated';
  const isRunning = Boolean(conversation && running.ids.has(conversation.sessionId));
  const others = running.list.filter((entry) => entry.sessionId !== conversation?.sessionId).length;
  const projectPath = project ? `/projects/${encodeURIComponent(project.projectId)}` : '';
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
          {section('현재 작업')}
          <div className="space-y-2 px-1" data-testid="drawer-current">
            {project ? (
              <button type="button" className={card} onClick={() => open(projectPath)} aria-current={pathname === projectPath ? 'page' : undefined}>
                <div className="flex items-center gap-1.5 text-[11px] text-muted"><FolderGit2 size={13} /> 프로젝트</div>
                <div className="mt-0.5 truncate text-[15px] font-medium">{project.displayName}</div>
                <div className="truncate text-[12px] text-muted">{collapseWorkspacesRoot(project.fullPath, workspacesRoot)}</div>
              </button>
            ) : (
              <div className="rounded-xl border border-dashed border-line px-3 py-2.5 text-[13px] text-muted">선택된 프로젝트가 없습니다 · 홈의 프로젝트 탭에서 고르거나 추가하세요</div>
            )}
            {conversation ? (
              <button type="button" className={card} onClick={() => open(`/session/${encodeURIComponent(conversation.sessionId)}`)}>
                <div className="flex items-center gap-1.5 text-[11px] text-muted">
                  <MessageSquare size={13} /> {isRunning ? '진행 중인 대화' : '최근 대화'}
                  {isRunning ? <span className="ml-auto flex items-center gap-1 text-accent"><span className="h-1.5 w-1.5 rounded-full bg-accent m-pulse" />응답 중</span> : null}
                </div>
                <div className="mt-0.5 truncate text-[15px] font-medium">{conversation.title || '(제목 없음)'}</div>
                {conversation.projectName && conversation.projectId !== project?.projectId ? <div className="truncate text-[12px] text-muted">{conversation.projectName}</div> : null}
              </button>
            ) : null}
            {others > 0 ? <button type="button" className="w-full px-2 py-1 text-left text-[13px] text-accent" onClick={() => open('/')}>다른 대화 {others}개 실행 중 ›</button> : null}
          </div>

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
