import type { ChatMessage, RunCompleteDetail } from '@/shared/types';

export const RUN_COMPLETE_EVENT = 'aidev:run-complete';
// tools that write a file (Claude Edit/Write/MultiEdit/NotebookEdit, Codex ApplyPatch)
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ApplyPatch', 'apply_patch']);

/** The files the assistant's tools wrote since the last user message, newest first, without repeats. */
export function changedFilesSince(messages: ChatMessage[]): string[] {
  const files: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'user') break;
    if (!message.isToolUse || !message.toolName || !WRITE_TOOLS.has(message.toolName)) continue;
    const input = (message.toolInput && typeof message.toolInput === 'object' ? message.toolInput : {}) as Record<string, unknown>;
    const path = [input.file_path, input.path, input.notebook_path].find((value): value is string => typeof value === 'string' && value.trim() !== '');
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

/** Used by the chat module when a run ends; the workbench listens (ui.artifact / ui.focus). */
export function announceRunComplete(detail: RunCompleteDetail) {
  window.dispatchEvent(new CustomEvent<RunCompleteDetail>(RUN_COMPLETE_EVENT, { detail }));
}
