import { memo, useCallback } from 'react';

import { useProjectMainState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { SessionEstablishedContext, SessionNavigationOptions,ProjectWorkspaceShellProps } from '@/shared/types';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import { WorkbenchLayout, useDeviceTier } from '@/modules/workbench';

/** Rendered by ProjectWorkspaceShell to bind this module's project state to WorkspaceMain. */
function ProjectMainRegion({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  const {
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    setSidebarOpen,
    isLoadingProjects,
    openSettings,
    externalMessageUpdate,
    newSessionTrigger,
    registerOptimisticSession,
    handleProjectSelect,
    refreshProjectsSilently,
  } = useProjectMainState();

  const handleOpenSidebar = useCallback(() => {
    setSidebarOpen(true);
  }, [setSidebarOpen]);

  const handleNavigateToSession = useCallback((
    targetSessionId: string,
    options?: SessionNavigationOptions,
  ) => {
    navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) });
  }, [navigate]);

  const handleSessionEstablished = useCallback((
    targetSessionId: string,
    context: SessionEstablishedContext,
  ) => {
    registerOptimisticSession({ sessionId: targetSessionId, ...context });
  }, [registerOptimisticSession]);

  const handleProjectsRefresh = useCallback(() => {
    void refreshProjectsSilently();
  }, [refreshProjectsSilently]);

  // Nado AI Dev: tablets and desktops get the IDE workbench (IMPLEMENTATION-PLAN §3.11); the tabbed
  // layout below stays for the mobile tier and for the `legacy_layout` escape hatch.
  const tier = useDeviceTier();
  const legacyLayout = (() => { try { return localStorage.getItem('aidev.legacy_layout') === '1'; } catch { return false; } })();
  if (!isMobile && tier !== 'mobile' && !legacyLayout) {
    return (
      <WorkbenchLayout
        tier={tier}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        ws={ws}
        sendMessage={sendMessage}
        isMobile={false}
        onMenuClick={handleOpenSidebar}
        isLoading={isLoadingProjects}
        onNavigateToSession={handleNavigateToSession}
        onSessionEstablished={handleSessionEstablished}
        onShowSettings={openSettings}
        externalMessageUpdate={externalMessageUpdate}
        newSessionTrigger={newSessionTrigger}
        onProjectSelect={handleProjectSelect}
        onProjectsRefresh={handleProjectsRefresh}
      />
    );
  }

  return (
    <WorkspaceMain
      selectedProject={selectedProject}
      selectedSession={selectedSession}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      ws={ws}
      sendMessage={sendMessage}
      isMobile={isMobile}
      onMenuClick={handleOpenSidebar}
      isLoading={isLoadingProjects}
      onNavigateToSession={handleNavigateToSession}
      onSessionEstablished={handleSessionEstablished}
      onShowSettings={openSettings}
      externalMessageUpdate={externalMessageUpdate}
      newSessionTrigger={newSessionTrigger}
      onProjectSelect={handleProjectSelect}
      onProjectsRefresh={handleProjectsRefresh}
    />
  );
}

export default memo(ProjectMainRegion);
