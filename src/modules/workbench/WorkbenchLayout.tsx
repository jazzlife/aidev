import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Bot, Code2, FolderTree, GitBranch, Globe, ListChecks, MessageSquare, MessagesSquare, MonitorSmartphone, PanelBottom, PanelLeft, PanelRight, Settings, SlidersHorizontal, TerminalSquare, X } from 'lucide-react';

import { ChatInterface } from '@/modules/chat';
import { FileTree } from '@/modules/file-tree';
import { StandaloneShell } from '@/modules/standalone-shell';
import { GitPanel } from '@/modules/git-panel';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { toggleQuickSettings } from '@/modules/quick-settings-panel';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver, WorkspaceErrorBoundary, WorkspaceStateView } from '@/modules/project-workspace';
import type { DirectoryRevealRequest, WorkspaceMainProps } from '@/shared/types';
import { AgentCatalog } from '@/modules/aidev-router';
import { TargetsPanel } from '@/modules/remote-target';
import { EditorGroup, useEditorGroup } from '@/modules/workbench/EditorGroup';
import { SplitHandle } from '@/modules/workbench/SplitHandle';
import { layoutStore, useWorkbenchLayout, type BottomTab, type SideView, type TabletPane } from '@/modules/workbench/layoutStore';
import type { DeviceTier } from '@/modules/workbench/hooks/useDeviceTier';

type WorkbenchLayoutProps = WorkspaceMainProps & {
  tier: Exclude<DeviceTier, 'mobile'>;
  /** Project/session navigation (the embedded CloudCLI sidebar). Kept mounted: it also hosts the settings and new-project modals. */
  sessionsPanel: ReactNode;
};

const SIDE_VIEWS: Array<{ id: SideView; title: string; icon: typeof FolderTree }> = [
  { id: 'sessions', title: '세션', icon: MessagesSquare },
  { id: 'explorer', title: '탐색기', icon: FolderTree },
  { id: 'git', title: 'Git', icon: GitBranch },
  { id: 'targets', title: '원격 대상', icon: MonitorSmartphone },
  { id: 'catalog', title: 'Agent 카탈로그', icon: Bot },
];
const BOTTOM_TABS: Array<{ id: BottomTab; title: string; icon: typeof TerminalSquare }> = [
  { id: 'terminal', title: '터미널', icon: TerminalSquare },
  { id: 'browser', title: '브라우저', icon: Globe },
  { id: 'tasks', title: '작업', icon: ListChecks },
];
const TABLET_PANES: Array<{ id: TabletPane; title: string }> = [
  { id: 'files', title: '파일' }, { id: 'terminal', title: '터미널' }, { id: 'git', title: 'Git' }, { id: 'browser', title: '브라우저' },
];

/**
 * IDE workbench for tablet and desktop (IMPLEMENTATION-PLAN §3.11). Composes the existing CloudUI
 * modules as panes: activity bar + side view | editor group / bottom panel | chat. Rendered by
 * ProjectMainRegion instead of the tabbed WorkspaceMain when the device tier is not mobile.
 * It owns the only left navigation: sessions are the first activity-bar view on desktop and a
 * slide-over drawer on tablet (the docked CloudCLI sidebar is not rendered alongside it).
 */
function WorkbenchLayout(props: WorkbenchLayoutProps) {
  const { selectedProject, selectedSession, ws, sendMessage, isLoading, sessionsPanel, onNavigateToSession, onSessionEstablished, onShowSettings, externalMessageUpdate, newSessionTrigger, onProjectSelect, onProjectsRefresh, setActiveTab, tier } = props;
  const layout = useWorkbenchLayout(tier);
  const { showRawParameters, showThinking, sendByCtrlEnter } = useUiPreferences();
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();
  useTaskMasterProjectSync(selectedProject);
  const [revealDirectory, setRevealDirectory] = useState<DirectoryRevealRequest | null>(null);
  const editor = useEditorGroup(selectedProject?.projectId);
  const isTablet = tier === 'tablet';
  // Tablet drawer for sessions; closes itself once a session is picked.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [selectedSession?.id, selectedProject?.projectId]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  // Deep link from a notification (`/?view=catalog`, e.g. knowledge waiting for review): open that side view once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') !== 'catalog') return;
    layoutStore.patch(tier, { sideView: 'catalog' });
    params.delete('view');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
  }, [tier]);
  const noProject = isLoading || !selectedProject;
  const openSessions = useCallback(() => {
    if (tier === 'tablet') setDrawerOpen(true);
    else layoutStore.patch('desktop', { sideView: 'sessions' });
  }, [tier]);

  // Chat/file-tree/git hand us paths (optionally with a diff or a line); everything lands in the editor group.
  const handleFileOpen = useCallback((filePath: string, diffInfo?: unknown, line?: number | null) => {
    editor.api.open(filePath, (diffInfo as never) ?? null, line ?? null);
    if (isTablet) layoutStore.patch('tablet', { tabletShowChat: false, tabletPane: 'files' });
    else layoutStore.patch('desktop', { workOpen: true });   // the code panel appears when there is code to show
  }, [editor.api, isTablet]);
  // ...and goes away with its last editor tab, unless the terminal panel keeps it in use.
  const tabCountRef = useRef(editor.tabs.length);
  useEffect(() => {
    const previous = tabCountRef.current;
    tabCountRef.current = editor.tabs.length;
    if (!isTablet && previous > 0 && editor.tabs.length === 0 && !layoutStore.get('desktop').bottomOpen) layoutStore.patch('desktop', { workOpen: false });
  }, [editor.tabs.length, isTablet]);
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen as never);
  const openFile = useCallback((filePath: string) => { handleFileOpen(filePath); }, [handleFileOpen]);
  const openFileInEditor = useCallback((filePath: string, line?: number | null) => { resolvedFileOpen(filePath, undefined, line); }, [resolvedFileOpen]);
  const openDirectory = useCallback((directoryPath: string) => {
    layoutStore.patch(tier, { sideView: 'explorer' });
    setRevealDirectory({ path: directoryPath });
  }, [tier]);
  usePaletteOpsRegister({ openFile, openFileInEditor, openDirectory });
  // The legacy tab state still drives a few upstream effects (task banner, palette); keep it on chat.
  useEffect(() => { setActiveTab('chat'); }, [setActiveTab]);

  const showAllTasks = useCallback(() => { layoutStore.patch(tier, { bottomOpen: true, bottomTab: 'tasks' }); }, [tier]);
  const shouldShowTasks = Boolean(tasksEnabled && isTaskMasterInstalled);
  const bottomTabs = useMemo(() => BOTTOM_TABS.filter((tab) => (tab.id === 'tasks' ? shouldShowTasks : tab.id === 'browser' ? browserUseEnabled : true)), [browserUseEnabled, shouldShowTasks]);
  const bottomTab: BottomTab = bottomTabs.some((tab) => tab.id === layout.bottomTab) ? layout.bottomTab : 'terminal';

  const stateView = <WorkspaceStateView mode={isLoading ? 'loading' : 'empty'} isMobile={false} onMenuClick={openSessions} />;
  const quickSettingsButton = <button type="button" title="빠른 설정" aria-label="빠른 설정" onClick={() => toggleQuickSettings()} className="p-2 rounded text-muted-foreground hover:text-foreground hover:bg-muted"><SlidersHorizontal size={isTablet ? 16 : 18} /></button>;
  const settingsButton = <button type="button" title="설정" aria-label="설정" onClick={() => onShowSettings?.()} className="p-2 rounded text-muted-foreground hover:text-foreground hover:bg-muted"><Settings size={isTablet ? 16 : 18} /></button>;

  if (noProject) {
    // No project yet: the sessions list is the only useful thing on screen, so it is always shown.
    return (
      <div className="flex h-full min-h-0">
        <div className="aidev-chrome shrink-0 border-r border-border overflow-hidden" style={{ width: isTablet ? 300 : layout.sideWidth }}>{sessionsPanel}</div>
        <div className="flex-1 min-w-0">{stateView}</div>
      </div>
    );
  }

  const chat = (
    <WorkspaceErrorBoundary showDetails>
      <ChatInterface
        isActive
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        ws={ws}
        sendMessage={sendMessage}
        onFileOpen={handleFileOpen}
        onNavigateToSession={onNavigateToSession}
        onSessionEstablished={onSessionEstablished}
        onShowSettings={onShowSettings}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
        sendByCtrlEnter={sendByCtrlEnter}
        externalMessageUpdate={externalMessageUpdate}
        newSessionTrigger={newSessionTrigger}
        onShowAllTasks={shouldShowTasks ? showAllTasks : null}
      />
    </WorkspaceErrorBoundary>
  );
  const explorer = <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpen} revealDirectory={revealDirectory} showTitle={false} />;
  const git = <GitPanel selectedProject={selectedProject} isMobile={false} onFileOpen={handleFileOpen} onProjectSelect={onProjectSelect} onProjectsRefresh={onProjectsRefresh} />;
  const terminal = (active: boolean) => <StandaloneShell project={selectedProject} session={selectedSession} showHeader={false} isActive={active} />;
  const editorGroup = <EditorGroup tabs={editor.tabs} active={editor.active} onActivate={editor.setActive} onClose={editor.api.close} projectPath={selectedProject.path} />;

  if (isTablet) {
    // Two panes: chat, or one tool pane, switched by the segmented control (swipe lands in C-05).
    const pane = layout.tabletPane;
    return (
      <div className="relative flex h-full flex-col">
        <div className="aidev-chrome flex items-center gap-1 px-2 h-10 border-b border-border bg-muted/30 shrink-0">
          <button type="button" onClick={() => setDrawerOpen(true)} aria-label="세션" title="세션" className="p-2 rounded hover:bg-muted"><PanelLeft size={16} /></button>
          <div className="flex-1 min-w-0 truncate text-sm font-medium">{selectedProject.displayName}{selectedSession?.summary ? ` · ${selectedSession.summary}` : ''}</div>
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            <button type="button" className={`px-3 h-7 ${layout.tabletShowChat ? 'bg-primary text-primary-foreground' : ''}`} onClick={() => layoutStore.patch('tablet', { tabletShowChat: true })}>채팅</button>
            {TABLET_PANES.filter((entry) => entry.id !== 'browser' || browserUseEnabled).map((entry) => (
              <button key={entry.id} type="button" className={`px-3 h-7 border-l border-border ${!layout.tabletShowChat && pane === entry.id ? 'bg-primary text-primary-foreground' : ''}`} onClick={() => layoutStore.patch('tablet', { tabletShowChat: false, tabletPane: entry.id })}>{entry.title}</button>
            ))}
          </div>
          {quickSettingsButton}
          {settingsButton}
        </div>
        {/* sessions drawer: slides over the panes instead of docking beside them */}
        <div className={`absolute inset-0 z-40 ${drawerOpen ? '' : 'pointer-events-none'}`} aria-hidden={!drawerOpen}>
          <button type="button" aria-label="세션 닫기" tabIndex={drawerOpen ? 0 : -1} onClick={() => setDrawerOpen(false)} className={`absolute inset-0 bg-background/60 backdrop-blur-[1px] transition-opacity duration-150 ${drawerOpen ? 'opacity-100' : 'opacity-0'}`} />
          <div className={`aidev-chrome absolute left-0 top-0 bottom-0 w-[320px] max-w-[85vw] border-r border-border bg-background shadow-xl transition-transform duration-150 ease-out flex flex-col ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {/* closes on backdrop tap, Escape, or once a session is picked */}
            <div className="flex-1 min-h-0">{sessionsPanel}</div>
          </div>
        </div>
        <div className="flex-1 min-h-0 relative">
          <div className={`absolute inset-0 ${layout.tabletShowChat ? '' : 'hidden'}`}>{chat}</div>
          {!layout.tabletShowChat && pane === 'files' ? (
            <div className="absolute inset-0 flex">
              <div className="w-[260px] shrink-0 border-r border-border overflow-hidden">{explorer}</div>
              <div className="flex-1 min-w-0">{editorGroup}</div>
            </div>
          ) : null}
          <div className={`absolute inset-0 ${!layout.tabletShowChat && pane === 'terminal' ? '' : 'hidden'}`}>{terminal(!layout.tabletShowChat && pane === 'terminal')}</div>
          {!layout.tabletShowChat && pane === 'git' ? <div className="absolute inset-0">{git}</div> : null}
          {!layout.tabletShowChat && pane === 'browser' && browserUseEnabled ? <div className="absolute inset-0"><BrowserUsePanel isVisible onShowSettings={onShowSettings} /></div> : null}
        </div>
      </div>
    );
  }

  const sideView = layout.sideView;
  const workVisible = layout.workOpen;
  // Terminal on → it lives in the code panel, so the panel opens with it; off with no open file → the panel closes too.
  const toggleBottom = () => {
    const next = !(workVisible && layout.bottomOpen);
    layoutStore.patch('desktop', next ? { bottomOpen: true, workOpen: true } : { bottomOpen: false, workOpen: editor.tabs.length > 0 });
  };
  return (
    <div className="flex h-full min-h-0">
      {/* activity bar */}
      <div className="aidev-chrome w-11 shrink-0 flex flex-col items-center gap-1 py-2 border-r border-border bg-muted/40">
        {SIDE_VIEWS.map((view) => (
          <button key={view.id} type="button" title={view.title} aria-label={view.title} aria-pressed={sideView === view.id} onClick={() => layoutStore.patch('desktop', { sideView: sideView === view.id ? null : view.id })}
            className={`p-2 rounded ${sideView === view.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}><view.icon size={18} /></button>
        ))}
        <div className="flex-1" />
        <button type="button" title="터미널 패널" aria-label="터미널 패널" aria-pressed={workVisible && layout.bottomOpen} onClick={toggleBottom} className={`p-2 rounded ${workVisible && layout.bottomOpen ? 'text-foreground' : 'text-muted-foreground'} hover:bg-muted`}><PanelBottom size={18} /></button>
        <button type="button" title="코드 패널" aria-label="코드 패널" aria-pressed={workVisible} onClick={() => layoutStore.patch('desktop', { workOpen: !workVisible })} className={`p-2 rounded ${workVisible ? 'text-foreground' : 'text-muted-foreground'} hover:bg-muted`}><PanelRight size={18} /></button>
        {quickSettingsButton}
        {settingsButton}
      </div>
      {/* side view */}
      <div className={`aidev-chrome shrink-0 min-w-[200px] overflow-hidden border-r border-border flex flex-col ${sideView ? '' : 'hidden'}`} style={{ width: layout.sideWidth }}>
        {sideView && sideView !== 'sessions' ? <div className="h-8 px-3 flex items-center text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border shrink-0">{SIDE_VIEWS.find((view) => view.id === sideView)?.title}</div> : null}
        {/* the sessions panel stays mounted across view switches (it owns the settings / new-project modals) */}
        <div className={`flex-1 min-h-0 overflow-hidden ${sideView === 'sessions' ? '' : 'hidden'}`}>{sessionsPanel}</div>
        {sideView && sideView !== 'sessions' ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            {sideView === 'explorer' ? explorer : sideView === 'git' ? git : sideView === 'targets' ? <TargetsPanel /> : <AgentCatalog />}
          </div>
        ) : null}
      </div>
      {sideView ? <SplitHandle edge="right" size={layout.sideWidth} min={200} max={600} onSize={(size) => layoutStore.patch('desktop', { sideWidth: size })} /> : null}
      {/* center: the chat is the main column */}
      <div className="flex-1 min-w-[360px] flex flex-col min-h-0">
        <div className="aidev-chrome h-8 px-3 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border shrink-0"><MessageSquare size={12} /> 채팅{selectedSession?.summary ? <span className="normal-case tracking-normal truncate text-foreground/80">· {selectedSession.summary}</span> : null}</div>
        <div className="flex-1 min-h-0">{chat}</div>
      </div>
      {/* right: code panel (editor group + bottom panel), only while needed. Kept mounted when hidden
          so open tabs and the terminal session survive closing it. */}
      {workVisible ? <SplitHandle edge="left" size={layout.workWidth} min={360} max={1400} onSize={(size) => layoutStore.patch('desktop', { workWidth: size })} /> : null}
      <div className={`shrink-0 min-w-[360px] max-w-[70vw] border-l border-border flex flex-col min-h-0 ${workVisible ? '' : 'hidden'}`} style={{ width: layout.workWidth }}>
        <div className="aidev-chrome h-8 px-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border shrink-0">
          <Code2 size={12} /> 코드{editor.tabs.length ? <span className="normal-case tracking-normal">· {editor.tabs.length}개 파일</span> : null}
          <button type="button" aria-label="코드 패널 닫기" title="코드 패널 닫기" onClick={() => layoutStore.patch('desktop', { workOpen: false })} className="ml-auto p-1 rounded hover:bg-muted"><X size={13} /></button>
        </div>
        <div className="flex-1 min-h-0">{editorGroup}</div>
        {layout.bottomOpen ? (
          <>
            <SplitHandle edge="top" size={layout.bottomHeight} min={120} max={800} onSize={(size) => layoutStore.patch('desktop', { bottomHeight: size })} />
            <div className="shrink-0 flex flex-col border-t border-border" style={{ height: layout.bottomHeight }}>
              <div className="aidev-chrome h-8 flex items-center gap-1 px-2 border-b border-border bg-muted/30 text-xs shrink-0" role="tablist">
                {bottomTabs.map((tab) => (
                  <button key={tab.id} type="button" role="tab" aria-selected={bottomTab === tab.id} onClick={() => layoutStore.patch('desktop', { bottomTab: tab.id })} className={`flex items-center gap-1 px-2 h-6 rounded ${bottomTab === tab.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}><tab.icon size={13} />{tab.title}</button>
                ))}
              </div>
              <div className="flex-1 min-h-0 relative">
                <div className={`absolute inset-0 ${bottomTab === 'terminal' ? '' : 'hidden'}`}>{terminal(workVisible && bottomTab === 'terminal')}</div>
                {shouldShowTasks ? <div className={`absolute inset-0 ${bottomTab === 'tasks' ? '' : 'hidden'}`}><TaskMasterPanel isVisible={workVisible && bottomTab === 'tasks'} /></div> : null}
                {browserUseEnabled && bottomTab === 'browser' ? <div className="absolute inset-0"><BrowserUsePanel isVisible={workVisible} onShowSettings={onShowSettings} /></div> : null}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default memo(WorkbenchLayout);
