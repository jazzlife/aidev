/**
 * remote-debug — debugging programs on the user's PCs (IMPLEMENTATION-PLAN §3.12, F-09), non-visual part:
 * the shared debug store (editor breakpoints, selected session, path maps), workspace ↔ PC path mapping and
 * the session hooks. The gateway is the DAP client. UI: remote-target DebugPane (workbench), the code
 * editor's breakpoint gutter, src-mobile DebugScreen.
 */
export { debugStore, useDebugStore } from '@/modules/remote-debug/debugStore';
export { DEBUG_STATE_LABEL, useAgentDebugSessions, useDebugSession, useDebugSessions } from '@/modules/remote-debug/hooks/useDebugSession';
export { adapterFor, defaultTargetFolder, guessPathMap, splitArgs, toRuntimePath, toTargetPath } from '@/modules/remote-debug/pathMap';
export type { DebugPathMap } from '@/modules/remote-debug/pathMap';
