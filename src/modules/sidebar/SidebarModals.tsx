import { useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, BookmarkMinus, EyeOff, FolderX, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { Settings } from '@/modules/settings';
import { VersionUpgradeModal } from '@/modules/version-upgrade';
import type { InstallMode, PendingSidebarDeletion, Project, ProjectRemovalMode, ReleaseInfo, SettingsProject } from '@/shared/types';
import { normalizeProjectForSettings } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { ProjectCreationWizard } from '@/modules/project-creation-wizard';

type SidebarModalsProps = {
  projects: Project[];
  showSettings: boolean;
  settingsInitialTab: string;
  onCloseSettings: () => void;
  showNewProject: boolean;
  onCloseNewProject: () => void;
  /** back from GitHub login started in the clone tab: reopen that tab with the outcome */
  newProjectReturn: { notice: { text: string; error: boolean } | null } | null;
  onProjectCreated: () => void;
  pendingDeletion: PendingSidebarDeletion | null;
  onCancelDeletion: () => void;
  onConfirmDeleteProject: (mode: ProjectRemovalMode) => void;
  onConfirmDeleteSession: (hardDelete?: boolean) => void;
  showVersionModal: boolean;
  onCloseVersionModal: () => void;
  releaseInfo: ReleaseInfo | null;
  currentVersion: string;
  latestVersion: string | null;
  installMode: InstallMode;
  t: TFunction;
};

type TypedSettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  projects: SettingsProject[];
  initialTab: string;
};

const SettingsComponent = Settings as (props: TypedSettingsProps) => JSX.Element;

function TypedSettings(props: TypedSettingsProps) {
  return <SettingsComponent {...props} />;
}

type ProjectRemovalDialogProps = {
  project: Project;
  sessionCount: number;
  onConfirm: (mode: ProjectRemovalMode) => void;
  onCancel: () => void;
  t: TFunction;
};

/**
 * Asks what removing a project means: hide it (restorable), drop only the
 * bookmark (folder and repository stay), or delete the folder too — the last
 * behind a second step that names the folder.
 */
function ProjectRemovalDialog({ project, sessionCount, onConfirm, onCancel, t }: ProjectRemovalDialogProps) {
  // Folder deletion cannot be undone, so its choice opens a confirmation step instead of acting at once.
  const [isConfirmingFolder, setIsConfirmingFolder] = useState(false);
  const projectName = project.displayName || project.projectId;
  const projectPath = project.fullPath || project.path || '';
  const optionClassName = 'h-auto w-full justify-start whitespace-normal py-2.5 text-left';
  const hintClassName = 'block text-xs font-normal text-muted-foreground';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full ${isConfirmingFolder ? 'bg-red-100 dark:bg-red-900/30' : 'bg-orange-100 dark:bg-orange-900/30'}`}>
              <AlertTriangle className={`h-6 w-6 ${isConfirmingFolder ? 'text-red-600 dark:text-red-400' : 'text-orange-600 dark:text-orange-400'}`} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="mb-2 text-lg font-semibold text-foreground">
                {isConfirmingFolder
                  ? t('deleteConfirmation.deleteFolderTitle', 'Delete the project folder?')
                  : t('deleteConfirmation.deleteProject')}
              </h3>
              <p className="mb-1 text-sm text-muted-foreground">
                {t('deleteConfirmation.confirmDelete')}{' '}
                <span className="font-medium text-foreground">{projectName}</span>
                ?
              </p>
              {projectPath && (
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{projectPath}</p>
              )}
              {isConfirmingFolder ? (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {t('deleteConfirmation.deleteFolderWarning', 'The folder and every file in it are deleted from disk. Changes not committed and pushed cannot be recovered. A remote repository such as GitHub is not deleted.')}
                </p>
              ) : sessionCount > 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('deleteConfirmation.sessionCount', { count: sessionCount })}
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
          {isConfirmingFolder ? (
            <>
              <Button
                variant="destructive"
                className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                onClick={() => onConfirm('folder')}
              >
                <FolderX className="mr-2 h-4 w-4" />
                {t('deleteConfirmation.deleteFolderConfirm', 'Delete the folder')}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => setIsConfirmingFolder(false)}>
                {t('deleteConfirmation.back', 'Back')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" className={optionClassName} onClick={() => onConfirm('archive')}>
                <EyeOff className="mr-2 h-4 w-4 flex-shrink-0" />
                <span>
                  {t('deleteConfirmation.archiveProject', 'Archive project')}
                  <span className={hintClassName}>
                    {t('deleteConfirmation.archiveProjectHint', 'Hidden from the list; restore it from the archive any time.')}
                  </span>
                </span>
              </Button>
              <Button variant="outline" className={optionClassName} onClick={() => onConfirm('bookmark')}>
                <BookmarkMinus className="mr-2 h-4 w-4 flex-shrink-0" />
                <span>
                  {t('deleteConfirmation.removeBookmark', 'Remove the bookmark only')}
                  <span className={hintClassName}>
                    {t('deleteConfirmation.removeBookmarkHint', 'Removes the project and its conversation history from the app. The folder and its repository stay on disk.')}
                  </span>
                </span>
              </Button>
              <Button
                variant="outline"
                className={`${optionClassName} border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20`}
                onClick={() => setIsConfirmingFolder(true)}
              >
                <Trash2 className="mr-2 h-4 w-4 flex-shrink-0" />
                <span>
                  {t('deleteConfirmation.deleteFolder', 'Delete the folder too')}
                  <span className={hintClassName}>
                    {t('deleteConfirmation.deleteFolderHint', 'Also deletes the project folder from disk.')}
                  </span>
                </span>
              </Button>
              <Button variant="ghost" className="w-full" onClick={onCancel}>
                {t('actions.cancel')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rendered by Sidebar to host its settings, new-project, delete-confirmation and version modals in one place. */
export default function SidebarModals({
  projects,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  showNewProject,
  onCloseNewProject,
  newProjectReturn,
  onProjectCreated,
  pendingDeletion,
  onCancelDeletion,
  onConfirmDeleteProject,
  onConfirmDeleteSession,
  showVersionModal,
  onCloseVersionModal,
  releaseInfo,
  currentVersion,
  latestVersion,
  installMode,
  t,
}: SidebarModalsProps) {
  // Settings expects project identity/path fields to be present for dropdown labels and local-scope MCP config.
  const settingsProjects = useMemo(
    () => projects.map(normalizeProjectForSettings),
    [projects],
  );

  return (
    <>
      {showNewProject &&
        ReactDOM.createPortal(
          <ProjectCreationWizard
            onClose={onCloseNewProject}
            onProjectCreated={onProjectCreated}
            initialTab={newProjectReturn ? 'clone' : 'folder'}
            notice={newProjectReturn?.notice}
          />,
          document.body,
        )}

      {showSettings &&
        ReactDOM.createPortal(
          <TypedSettings
            isOpen={showSettings}
            onClose={onCloseSettings}
            projects={settingsProjects}
            initialTab={settingsInitialTab}
          />,
          document.body,
        )}

      {pendingDeletion?.kind === 'project' &&
        ReactDOM.createPortal(
          <ProjectRemovalDialog
            project={pendingDeletion.project}
            sessionCount={pendingDeletion.sessionCount}
            onConfirm={onConfirmDeleteProject}
            onCancel={onCancelDeletion}
            t={t}
          />,
          document.body,
        )}

      {pendingDeletion?.kind === 'session' &&
        ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <div className="p-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                    <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="mb-2 text-lg font-semibold text-foreground">
                      {t('deleteConfirmation.deleteSession')}
                    </h3>
                    <p className="mb-1 text-sm text-muted-foreground">
                      {t('deleteConfirmation.confirmDelete')}{' '}
                      <span className="font-medium text-foreground">
                        {pendingDeletion.sessionTitle || t('sessions.unnamed')}
                      </span>
                      ?
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {pendingDeletion.isArchived
                        ? t('deleteConfirmation.archivedSessionNotice', 'This session is already archived. You can keep it hidden or delete it permanently.')
                        : t('deleteConfirmation.archiveSessionNotice', 'Archive keeps the session out of the active list while preserving its history.')}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 border-t border-border bg-muted/30 p-4">
                {!pendingDeletion.isArchived && (
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => onConfirmDeleteSession(false)}
                  >
                    <EyeOff className="mr-2 h-4 w-4" />
                    {t('deleteConfirmation.archiveSession', 'Archive session')}
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="w-full justify-start bg-red-600 text-white hover:bg-red-700"
                  onClick={() => onConfirmDeleteSession(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('deleteConfirmation.deleteSessionPermanently', 'Delete permanently')}
                </Button>
                <Button variant="ghost" className="w-full" onClick={onCancelDeletion}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <VersionUpgradeModal
        isOpen={showVersionModal}
        onClose={onCloseVersionModal}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        installMode={installMode}
      />
    </>
  );
}
