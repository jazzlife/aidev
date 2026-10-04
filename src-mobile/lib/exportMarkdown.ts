import type { NormalizedMessage } from '@/modules/chat-core';
import { summarizeToolInput } from '@m/lib/format';

/**
 * The conversation as Markdown (C-12.5), light enough for the phone: what was said, and one line per tool call. The
 * workbench's exporter renders tool output with its React renderers, so it stays there (with the HTML export).
 */
export function buildTranscriptMarkdown(title: string, messages: NormalizedMessage[], exportedAt = new Date()): string {
  const lines: string[] = [`# ${title || '대화'}`, '', `_${exportedAt.toLocaleString()} 내보냄_`, ''];
  let section: 'user' | 'assistant' | null = null;
  const heading = (role: 'user' | 'assistant') => {
    if (section === role) return;
    section = role;
    lines.push(role === 'user' ? '## 사용자' : '## Assistant', '');
  };
  for (const message of messages) {
    if ((message.kind === 'text' || message.kind === 'stream_delta') && message.role === 'user') {
      heading('user');
      const text = String(message.displayText || message.content || '').trim();
      const attached = [...(message.images ?? []), ...(message.files ?? [])].map((a) => a.name ?? a.path?.split(/[\\/]/).pop()).filter(Boolean);
      if (text) lines.push(text, '');
      if (attached.length) lines.push(`첨부: ${attached.join(', ')}`, '');
    } else if (message.kind === 'text' || message.kind === 'stream_delta') {
      const text = String(message.content ?? '').trim();
      if (!text) continue;
      heading('assistant');
      lines.push(text, '');
    } else if (message.kind === 'tool_use') {
      heading('assistant');
      const summary = summarizeToolInput(message.toolInput);
      lines.push(`- 🔧 **${message.toolName ?? 'tool'}**${summary ? `: \`${summary.replace(/`/g, "'")}\`` : ''}`, '');
    } else if (message.kind === 'error') {
      lines.push(`> ⚠️ ${String(message.content || message.text || '').trim()}`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Hands the file to the phone's share sheet (save, send, …) where it can take files; downloads it otherwise. */
export async function exportConversation(title: string, messages: NormalizedMessage[]): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const name = `${(title || '대화').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || '대화'}.md`;
  const file = new File([buildTranscriptMarkdown(title, messages)], name, { type: 'text/markdown' });
  const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title: name }); return 'shared'; }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}
