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
