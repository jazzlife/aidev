import { useSyncExternalStore } from 'react';

/**
 * "현재 작업" (C-12.1): the project a new conversation starts in and the conversation last opened. Shown by the
 * drawer; kept in localStorage so a cold start shows the same. The project key is the one ProjectPicker always used
 * (`readLastProject` reads it), so a new chat and the drawer never disagree.
 */
export type CurrentProject = { projectId: string; displayName: string; fullPath: string };
export type CurrentConversation = { sessionId: string; title: string; projectId: string; projectName: string; provider?: string };

const PROJECT_KEY = 'm.project';
const CONVERSATION_KEY = 'm.conversation';
const listeners = new Set<() => void>();

function read<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}

// cached so useSyncExternalStore gets the same object until something changes
let project = read<CurrentProject>(PROJECT_KEY);
let conversation = read<CurrentConversation>(CONVERSATION_KEY);

function write(key: string, value: unknown) {
  try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* storage full or off */ }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Used when a project screen opens, a conversation opens (its project), the project picker picks, a project is added. */
export function setCurrentProject(next: CurrentProject | null) {
  if (next && project && project.projectId === next.projectId && project.displayName === next.displayName && project.fullPath === next.fullPath) return;
  project = next ? { projectId: next.projectId, displayName: next.displayName, fullPath: next.fullPath } : null;
  write(PROJECT_KEY, project);
}

/** Used by ChatScreen whenever it knows the conversation's details (open, rename). */
export function setCurrentConversation(next: CurrentConversation) {
  if (conversation && JSON.stringify(conversation) === JSON.stringify(next)) return;
  conversation = next;
  write(CONVERSATION_KEY, conversation);
}

/** Used after a conversation is hidden or deleted: the drawer stops pointing at it. */
export function forgetConversation(sessionId: string) {
  if (conversation?.sessionId !== sessionId) return;
  conversation = null;
  write(CONVERSATION_KEY, null);
}

/** Used after a project is removed: the drawer and new chats stop using it. */
export function forgetProject(projectId: string) {
  if (project?.projectId !== projectId) return;
  project = null;
  write(PROJECT_KEY, null);
}

export const readCurrentProject = () => project;

export function useCurrentProject() {
  return useSyncExternalStore(subscribe, () => project);
}

export function useCurrentConversation() {
  return useSyncExternalStore(subscribe, () => conversation);
}

/** Tests: re-read storage (each test sets its own). */
export function reloadCurrentForTests() {
  project = read<CurrentProject>(PROJECT_KEY);
  conversation = read<CurrentConversation>(CONVERSATION_KEY);
  for (const listener of listeners) listener();
}
