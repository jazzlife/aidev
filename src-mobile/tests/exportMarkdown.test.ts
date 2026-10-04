import { describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/modules/chat-core';

vi.mock('@/modules/chat-core', () => ({ parseToolPayload: (value: unknown) => value }));
const { buildTranscriptMarkdown, exportConversation } = await import('@m/lib/exportMarkdown');

/** C-12.5: the phone's own Markdown export (what was said, one line per tool call). */
const base = { sessionId: 's1', timestamp: '', provider: 'claude' as const };
const messages: NormalizedMessage[] = [
  { ...base, id: '1', kind: 'text', role: 'user', content: '로그인 고쳐줘', images: [{ name: 'shot.png' }] },
  { ...base, id: '2', kind: 'thinking', content: '생각 중' },
  { ...base, id: '3', kind: 'tool_use', toolName: 'Read', toolInput: { file_path: 'src/login.ts' } },
  { ...base, id: '4', kind: 'tool_result', toolResult: { content: '...', isError: false } },
  { ...base, id: '5', kind: 'text', role: 'assistant', content: '고쳤습니다.' },
  { ...base, id: '6', kind: 'error', content: '시간 초과' },
];

describe('markdown export', () => {
  it('keeps the turns, one line per tool, no thinking or raw results', () => {
    const md = buildTranscriptMarkdown('로그인 버그', messages, new Date(0));
    expect(md.startsWith('# 로그인 버그\n')).toBe(true);
    expect(md).toContain('## 사용자\n\n로그인 고쳐줘\n\n첨부: shot.png');
    expect(md).toContain('## Assistant\n\n- 🔧 **Read**: `src/login.ts`\n\n고쳤습니다.');
    expect(md).toContain('> ⚠️ 시간 초과');
    expect(md).not.toContain('생각 중');
    expect(md.match(/## Assistant/g)).toHaveLength(1);
  });

  it('goes to the share sheet when the phone takes files, else downloads', async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { share, canShare: () => true });
    expect(await exportConversation('a/b', messages)).toBe('shared');
    expect((share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0]?.name).toBe('a b.md');
    Object.assign(navigator, { canShare: () => false });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:md'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    expect(await exportConversation('대화', messages)).toBe('downloaded');
    expect(click).toHaveBeenCalled();
  });
});
