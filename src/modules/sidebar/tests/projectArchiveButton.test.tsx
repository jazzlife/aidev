import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * Archiving a project is reachable from its row in both layouts, not only from
 * inside the delete dialog, and archives at once (it is restorable).
 */

vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

// Both the touch card and the desktop row must carry the indicator, so every
// case below runs once per layout.
let compactLayout = false;
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({
  useCompactSidebar: () => compactLayout,
}));

const eachLayout = (name: string, body: () => void) => {
  for (const compact of [false, true]) {
    test(`${name} (${compact ? 'touch' : 'desktop'} layout)`, () => {
      compactLayout = compact;
      body();
    });
  }
};

const { default: SidebarProjectItem } = await import('@/modules/sidebar/SidebarProjectItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

const session = (id: string): SessionWithProvider => ({
  id,
  summary: id,
  // Old enough not to count as "recently active", so only the processing dot can show.
  lastActivity: '2026-08-20T10:00:00.000Z',
  __provider: 'claude',
}) as unknown as SessionWithProvider;

const project: Project = {
  projectId: 'p1',
  name: 'p1',
  displayName: 'p1',
  fullPath: '/tmp/p1',
  sessions: [],
} as unknown as Project;

const NONE = new Set<string>();

const projectRowProps = (activeSessions: ReadonlySet<string>) => ({
  project,
  selectedProject: null,
  selectedSession: null,
  isExpanded: false,
  isDeleting: false,
  isStarred: false,
  isEditing: false,
  renameDraft: '',
  sessions: [session('s1'), session('s2')],
  initialSessionsLoaded: true,
  isLoadingMoreSessions: false,
  currentTime: NOW,
  sessionRenameId: null,
  sessionRenameDraft: '',
  tasksEnabled: false,
  mcpServerStatus: { isRunning: false, hasTaskMaster: false } as never,
  onRenameDraftChange: noop,
  onToggleProject: noop,
  onProjectSelect: noop,
  onToggleStarProject: noop,
  onStartEditingProject: noop,
  onCancelEditingProject: noop,
  onSaveProjectName: noop,
  onDeleteProject: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  onLoadMoreSessions: noop,
  activeSessions,
  attentionSessionIds: NONE,
  onNewSession: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  t,
});

eachLayout('the project row archives the project at once', () => {
  const calls: unknown[][] = [];
  const view = render(<SidebarProjectItem {...projectRowProps(NONE)} onDeleteProject={(...args: unknown[]) => calls.push(args)} />);
  const button = compactLayout ? view.getByLabelText('tooltips.archiveProject') : view.getByTitle('tooltips.archiveProject');
  fireEvent.click(button);
  assert.deepEqual(calls, [[project, { archiveNow: true }]]);
});
