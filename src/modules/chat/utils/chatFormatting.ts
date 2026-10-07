export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    return text.replace(/```[ \t]*([^\n\r]+?)[ \t]*```/g, '`$1`');
  } catch {
    return text;
  }
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes Codex's outer plan transport envelope while preserving its Markdown.
 * The closing tag is optional because streamed plans expose the opening tag
 * before the complete response arrives.
 */
export function stripProposedPlanEnvelope(text: string) {
  if (!text || typeof text !== 'string') return text;

  const openingTag = /^\s*<proposed_plan>[ \t]*(?:\r?\n)?/i;
  if (!openingTag.test(text)) return text;

  const withoutOpeningTag = text.replace(openingTag, '');
  return withoutOpeningTag.replace(/(?:\r?\n)?[ \t]*<\/proposed_plan>\s*$/i, '');
}

/**
 * Strips the agent-architect's raw `<aidev-agent>{...}</aidev-agent>` design block from a reply
 * before it reaches the transcript. `parseAgentDraft` already turns that block into the
 * AgentCreateCard, so showing the same JSON a second time as a chat bubble is pure noise — the
 * architect is told to keep surrounding text minimal, so there is rarely anything else to show.
 * Streaming-safe: while only the opening tag has arrived, everything from it onward is dropped too.
 */
export function stripAgentArchitectBlock(text: string) {
  if (!text || typeof text !== 'string') return text;
  const withoutClosedBlocks = text.replace(/<aidev-agent>\s*[\s\S]*?\s*<\/aidev-agent>/g, '');
  if (withoutClosedBlocks !== text) return withoutClosedBlocks.trim();
  const openIndex = text.indexOf('<aidev-agent>');
  return openIndex === -1 ? text : text.slice(0, openIndex).trimEnd();
}

export function formatUsageLimitText(text: string) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/Claude AI usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);

      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`;

      return `Claude usage limit reached. Your limit will reset at **${timeStr} ${tzHuman}** - ${dateReadable}`;
    });
  } catch {
    return text;
  }
}
