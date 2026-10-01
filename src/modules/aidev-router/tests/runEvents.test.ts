import { describe, expect, it } from 'vitest';

import { changedFilesSince } from '@/modules/aidev-router/runEvents';
import type { ChatMessage } from '@/shared/types';

const tool = (toolName: string, toolInput: Record<string, unknown>): ChatMessage => ({ type: 'assistant', timestamp: 0, isToolUse: true, toolName, toolInput });

describe('changedFilesSince (C-10)', () => {
  it('lists the files written since the last user message, newest first, once each', () => {
    const messages: ChatMessage[] = [
      { type: 'user', timestamp: 0, content: 'old turn' },
      tool('Write', { file_path: 'old.ts' }),
      { type: 'user', timestamp: 0, content: 'fix it' },
      tool('Read', { file_path: 'read-only.ts' }),
      tool('Edit', { file_path: 'src/a.ts' }),
      tool('ApplyPatch', { path: 'src/b.ts' }),
      tool('Edit', { file_path: 'src/a.ts' }),
      tool('Bash', { command: 'npm test' }),
      { type: 'assistant', timestamp: 0, content: 'done' },
    ];
    expect(changedFilesSince(messages)).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('is empty when nothing was written', () => {
    expect(changedFilesSince([{ type: 'user', timestamp: 0, content: 'hi' }, { type: 'assistant', timestamp: 0, content: 'hello' }])).toEqual([]);
  });
});
