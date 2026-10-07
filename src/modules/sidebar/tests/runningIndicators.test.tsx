import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import type { Project, RecentConversationListItem, SessionRowActions, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * A session producing a response must be visible from every list that shows it:
 * the Projects row (so a collapsed project still reveals it), the session row
 * under it, and the Conversations row. These assert the indicator each row
 * renders, keyed by its accessible label, for one running and one idle session.
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
const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');
const { default: SidebarRecentConversations } = await import('@/modules/sidebar/SidebarRecentConversations');

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

const RUNNING = new Set(['s1']);
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

eachLayout('a collapsed project row shows the running indicator while one of its sessions is processing', () => {
  const running = render(<SidebarProjectItem {...projectRowProps(RUNNING)} />);
  assert.ok(running.queryByRole('status', { name: 'tooltips.runningSessionsIndicator' }));
  running.unmount();

  const idle = render(<SidebarProjectItem {...projectRowProps(NONE)} />);
  assert.equal(idle.queryByRole('status', { name: 'tooltips.runningSessionsIndicator' }), null);
});

const sessionRowProps = (isProcessing: boolean) => ({
  project,
  session: session('s1'),
  selectedSession: null,
  isProcessing,
  needsAttention: false,
  currentTime: NOW,
  isEditing: false,
  renameDraft: '',
  onRenameDraftChange: noop,
  onStartEditingSession: noop,
  onCancelEditingSession: noop,
  onSaveEditingSession: noop,
  onProjectSelect: noop,
  onSessionSelect: noop,
  onDeleteSession: noop,
  t,
});

eachLayout('a session row shows the processing dot only while it is processing', () => {
  const running = render(<SidebarSessionItem {...sessionRowProps(true)} />);
  assert.ok(running.queryByRole('status', { name: 'tooltips.processingSessionIndicator' }));
  running.unmount();

  const idle = render(<SidebarSessionItem {...sessionRowProps(false)} />);
  assert.equal(idle.queryByRole('status', { name: 'tooltips.processingSessionIndicator' }), null);
});

eachLayout('a Conversations row shows the processing dot for a running session', () => {
  const conversations: RecentConversationListItem[] = ['s1', 's2'].map((sessionId) => ({
    sessionId,
    provider: 'claude',
    projectId: 'p1',
    projectDisplayName: 'p1',
    sessionTitle: sessionId,
    lastActivity: '2026-08-21T09:30:00.000Z',
  }));
  const sessionActions: SessionRowActions = {
    activeRename: null,
    activeSessions: RUNNING,
    attentionSessionIds: NONE,
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onDeleteSession: noop,
  };

  const list = render(
    <SidebarRecentConversations
      conversations={conversations}
      total={2}
      isLoading={false}
      hasMore={false}
      isLoadingMore={false}
      hasError={false}
      selectedSession={null}
      currentTime={NOW}
      sessionActions={sessionActions}
      onConversationSelect={noop}
      onLoadMore={noop}
      onRetry={noop}
      t={t}
    />,
  );

  assert.equal(list.getAllByRole('status', { name: 'tooltips.processingSessionIndicator' }).length, 1);
});
