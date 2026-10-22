import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, ProjectRemovalMode, SidebarProjectListProps } from '@/shared/types';

/**
 * Removing a project asks what it means: hide it, drop only the bookmark (the
 * folder stays), or delete the folder too — the last only after a second step
 * that names the folder.
 */

vi.mock('@/modules/settings', () => ({ Settings: () => null }));
vi.mock('@/modules/version-upgrade', () => ({ VersionUpgradeModal: () => null }));
vi.mock('@/modules/project-creation-wizard', () => ({ ProjectCreationWizard: () => null }));

const { default: SidebarModals } = await import('@/modules/sidebar/SidebarModals');

const t = ((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key)) as unknown as SidebarProjectListProps['t'];
const project: Project = { projectId: 'p1', displayName: 'alpha', fullPath: '/w/alpha' };

const renderDialog = () => {
  const chosen: ProjectRemovalMode[] = [];
  render(
    <SidebarModals
      projects={[]}
      showSettings={false}
      settingsInitialTab="agents"
      onCloseSettings={() => {}}
      showNewProject={false}
      onCloseNewProject={() => {}}
      newProjectReturn={null}
      onProjectCreated={() => {}}
      pendingDeletion={{ kind: 'project', project, sessionCount: 2 }}
      onCancelDeletion={() => {}}
      onConfirmDeleteProject={(mode) => chosen.push(mode)}
      onConfirmDeleteSession={() => {}}
      showVersionModal={false}
      onCloseVersionModal={() => {}}
      releaseInfo={null}
      currentVersion="1.0.0"
      latestVersion={null}
      installMode="npm"
      t={t}
    />,
  );
  return chosen;
};

test('archive and bookmark-only act at once', () => {
  const chosen = renderDialog();
  fireEvent.click(screen.getByText('Archive project'));
  fireEvent.click(screen.getByText('Remove the bookmark only'));
  assert.deepEqual(chosen, ['archive', 'bookmark']);
});

test('deleting the folder asks once more, naming the folder', () => {
  const chosen = renderDialog();
  fireEvent.click(screen.getByText('Delete the folder too'));
  assert.deepEqual(chosen, []);
  assert.ok(screen.getByText('/w/alpha'));

  fireEvent.click(screen.getByText('Back'));
  assert.ok(screen.getByText('Remove the bookmark only'));

  fireEvent.click(screen.getByText('Delete the folder too'));
  fireEvent.click(screen.getByText('Delete the folder'));
  assert.deepEqual(chosen, ['folder']);
});
