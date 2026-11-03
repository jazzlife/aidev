import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { ArchivedProjectListItem, ArchivedSessionListItem, SidebarProjectListProps } from '@/shared/types';

/**
 * Archive cards start collapsed so a long archive stays scannable, open on a
 * click, and start open while a search is typed so the matches are visible.
 */

vi.mock('@/modules/sidebar/SidebarHeader', () => ({ default: () => null }));
vi.mock('@/modules/sidebar/SidebarFooter', () => ({ default: () => null }));
vi.mock('@/modules/aidev-router', () => ({ UsageLimitPanel: () => null }));
vi.mock('@/shared/hooks/useWorkspacesRoot', () => ({ useWorkspacesRoot: () => null }));

const { default: SidebarContent } = await import('@/modules/sidebar/SidebarContent');

const t = ((key: string, fallback?: string) => fallback ?? key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const archivedProject = {
  projectId: 'p1',
  name: 'p1',
  displayName: 'Archived project',
  fullPath: '/tmp/p1',
  isArchived: true,
  sessions: [{ id: 's-in-project', summary: 'Session inside archived project', __provider: 'claude' }],
} as unknown as ArchivedProjectListItem;

const archivedSession: ArchivedSessionListItem = {
  sessionId: 's1',
  provider: 'claude',
  projectId: 'p2',
  projectPath: '/tmp/p2',
  projectDisplayName: 'Active project',
  sessionTitle: 'Archived session',
  createdAt: null,
  updatedAt: null,
  lastActivity: null,
  isProjectArchived: false,
};

const renderArchive = (searchFilter: string) => render(
  <SidebarContent
    {...({
      isPWA: false,
      isMobile: false,
      embedded: false,
      isLoading: false,
      projects: [],
      runningSessionsCount: 0,
      archivedProjects: [archivedProject],
      archivedSessions: [archivedSession],
      archivedSessionsCount: 2,
      isArchivedSessionsLoading: false,
      searchFilter,
      searchMode: 'archived',
      conversationResults: null,
      isSearching: false,
      searchProgress: null,
      onRestoreArchivedProject: noop,
      onArchivedSessionClick: noop,
      onRestoreArchivedSession: noop,
      onDeleteArchivedSession: noop,
      projectListProps: { currentTime: new Date('2026-11-03T00:00:00.000Z'), activeRename: null } as unknown as SidebarProjectListProps,
      t,
    } as unknown as React.ComponentProps<typeof SidebarContent>)}
  />,
);

test('archive cards are collapsed by default and open on a click', () => {
  const view = renderArchive('');
  assert.equal(view.queryByText('Session inside archived project'), null);
  assert.equal(view.queryByText('Archived session'), null);
  // Restoring a whole project stays one click away even while collapsed.
  assert.ok(view.getByLabelText('Restore workspace: Archived project'));

  fireEvent.click(view.getByText('Archived project'));
  fireEvent.click(view.getByText('Active project'));
  assert.ok(view.getByText('Session inside archived project'));
  assert.ok(view.getByText('Archived session'));

  fireEvent.click(view.getByText('Active project'));
  assert.equal(view.queryByText('Archived session'), null);
  view.unmount();
});

test('archive cards start open while searching', () => {
  const view = renderArchive('archived');
  assert.ok(view.getByText('Session inside archived project'));
  assert.ok(view.getByText('Archived session'));
  view.unmount();
});
