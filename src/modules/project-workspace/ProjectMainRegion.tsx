import { memo, useCallback } from 'react';

import { useProjectMainState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import type { SessionEstablishedContext, SessionNavigationOptions,ProjectWorkspaceShellProps } from '@/shared/types';
import WorkspaceMain from '@/modules/project-workspace/WorkspaceMain';
import { WorkbenchLayout, useWorkbenchActive } from '@/modules/workbench';
import { Sidebar } from '@/modules/sidebar';
import { RemoteApprovalCards } from '@/modules/remote-target';

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
  const { active: workbenchActive, tier } = useWorkbenchActive(isMobile);
  const { sidebarSharedProps } = useProjectSidebarState();
  if (workbenchActive && tier !== 'mobile') {
    return (
      <WorkbenchLayout
        tier={tier}
        // The one Sidebar instance while the workbench is active (the shell skips the docked one); it
        // also hosts the settings / new-project modals, so the workbench keeps it mounted at all times.
        sessionsPanel={<Sidebar {...sidebarSharedProps} isMobile={false} embedded />}
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

  // the narrow tabbed layout also shows agent remote commands waiting for approval (F-05)
  return (
    <div className="flex h-full min-h-0 flex-col">
    <RemoteApprovalCards />
    <div className="min-h-0 flex-1">
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
    </div>
    </div>
  );
}

export default memo(ProjectMainRegion);
