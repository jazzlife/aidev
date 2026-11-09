import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { TFunction } from 'i18next';

/**
 * Projects in the sidebar open and close independently: opening a second
 * project must leave the first one open, and closing one leaves the rest.
 */

vi.mock('@/shared/api', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }) }),
}));

const renderController = async () => {
  const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');
  const noop = () => undefined;
  // One args object for every render: a fresh `projects` array each render would re-run the hook's effects forever.
  const args = {
    projects: [],
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    isLoading: false,
    isMobile: false,
    t: ((key: string) => key) as unknown as TFunction,
    onRefresh: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    setCurrentProject: noop,
    setSidebarVisible: noop,
    sidebarVisible: true,
  };

  return renderHook(() => useSidebarController(args));
};

test('opening another project keeps the already open projects open', async () => {
  const { result } = await renderController();

  act(() => result.current.toggleProject('a'));
  act(() => result.current.toggleProject('b'));

  assert.equal(result.current.isProjectExpanded('a'), true);
  assert.equal(result.current.isProjectExpanded('b'), true);

  act(() => result.current.toggleProject('a'));

  assert.equal(result.current.isProjectExpanded('a'), false);
  assert.equal(result.current.isProjectExpanded('b'), true);
});
