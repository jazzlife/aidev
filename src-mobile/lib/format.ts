import { parseToolPayload } from '@/modules/chat-core';

/** Used by the sessions list and message timestamps. */
export function relativeTime(value?: string | number | null): string {
  if (!value) return '';
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}일 전`;
  return new Date(value).toLocaleDateString();
}

export function clampText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Used by tool cards and the Markdown export: the one line that says what a tool call was about. */
export function summarizeToolInput(input: unknown): string {
  const parsed = parseToolPayload(input);
  if (!parsed || typeof parsed !== 'object') return typeof parsed === 'string' ? clampText(parsed, 120) : '';
  const record = parsed as Record<string, unknown>;
  const keys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description'];
  for (const key of keys) {
    if (typeof record[key] === 'string') return clampText(record[key] as string, 120);
  }
  return clampText(JSON.stringify(record), 120);
}
