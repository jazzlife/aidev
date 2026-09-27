import { memo } from 'react';

import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import { useWorkbenchActive } from '@/modules/workbench';
import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  // With the workbench on screen, project/session navigation lives in its activity bar (one left
  // rail instead of the docked sidebar + activity bar), and quick settings open from there too.
  const { active: workbenchActive } = useWorkbenchActive(isMobile);
  return (
    <div
      className="fixed inset-0 flex bg-background"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      <ProjectEffects navigate={navigate} />
      {workbenchActive ? null : <ProjectSidebarRegion isMobile={isMobile} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <ProjectMainRegion
          isMobile={isMobile}
          ws={ws}
          sendMessage={sendMessage}
          navigate={navigate}
        />
      </div>

      <ProjectCommandPalette />
      <QuickSettingsPanel showHandle={!workbenchActive} />
    </div>
  );
}

export default memo(ProjectWorkspaceShell);
