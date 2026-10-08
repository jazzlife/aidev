import type { ChatMessage, ToolGroupItem } from '@/shared/types';
import { formatToolDisplayName, getToolConfig } from '@/modules/chat/tools/configs/toolConfigs';

export const TOOL_GROUP_THRESHOLD = 2;

/**
 * Tools whose card is addressed to the user rather than being a record of work
 * — a question to answer, a plan to approve, a checklist to follow. They stay
 * as their own row so a collapsed "x12" never hides something that needs a
 * reply, and they end the run of worker tools on either side of them.
 */
const UNGROUPABLE_TOOL_NAMES = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode', 'TodoWrite']);

/** How many of a group's tool inputs the collapsed summary line spells out. */
const PREVIEWED_TOOL_COUNT = 2;

/**
 * Longest text that still counts as a one-line narration caption rather than
 * prose. CLAUDE.md-style conventions ask the assistant to say what it's doing
 * in one short sentence before a routine tool call; that sentence announces
 * the next call rather than interrupting the run it's part of. Anything
 * longer, or spanning more than one line, is treated as real prose (an
 * explanation or a final summary) and still splits the run.
 */
const CAPTION_MAX_LENGTH = 100;

export type MessageListItem = ChatMessage | ToolGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

export function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(
    message.isToolUse
      && message.toolName
      && !message.isSubagentContainer
      && !UNGROUPABLE_TOOL_NAMES.has(message.toolName),
  );
}

/** The header name a tool goes by — the same one ToolGroupContainer prints. */
function getToolGroupLabel(toolName: string): string {
  return getToolConfig(toolName).input.label || formatToolDisplayName(toolName);
}

// Messages that render nothing (e.g. reasoning hidden when showThinking is off)
// shouldn't split an otherwise-continuous run of the same tool — providers like
// Codex interleave hidden reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && !showThinking);
}

// A sentence-ending mark followed by whitespace or the end of the string —
// used to count sentences. More than one means the text is a paragraph, not
// the single narration beat a caption is.
const SENTENCE_END = /[.!?](?:\s|$)/g;

// A short, single-sentence assistant turn is treated as a caption candidate:
// it may be the narration CLAUDE.md asks for before a routine tool call,
// which should not by itself break a run of the same tool. Whether it
// actually gets absorbed is decided by lookahead (see
// isFollowedByMoreTools) — this only screens out messages that could
// never qualify (real prose, user/error turns, tool calls, hidden reasoning).
function isCaptionCandidate(message: ChatMessage): boolean {
  if (message.type !== 'assistant' || message.isToolUse || message.isThinking || message.isSubagentContainer) {
    return false;
  }

  const text = (message.content || message.displayText || '').trim();
  if (!text || text.length > CAPTION_MAX_LENGTH || text.includes('\n')) {
    return false;
  }

  const sentenceEndings = text.match(SENTENCE_END);
  return !sentenceEndings || sentenceEndings.length <= 1;
}

/**
 * Looks past a caption candidate (and past any further captions or hidden
 * reasoning right after it — a provider can narrate more than once in a row)
 * to see whether another worker tool fires before anything else does. Any
 * groupable tool counts: a run spans tools (see isGroupableToolMessage).
 *
 * If real prose, a user-facing tool, or the end of the transcript comes first,
 * the caption in front of it is a genuine break — a wrap-up comment, not a
 * narration beat — so the run must end before it rather than swallow it.
 */
function isFollowedByMoreTools(
  messages: ChatMessage[],
  fromIndex: number,
  showThinking: boolean,
): boolean {
  let index = fromIndex;

  while (index < messages.length) {
    const candidate = messages[index];

    if (rendersNothing(candidate, showThinking)) {
      index += 1;
      continue;
    }

    if (isGroupableToolMessage(candidate)) {
      return true;
    }

    if (isCaptionCandidate(candidate)) {
      index += 1;
      continue;
    }

    return false;
  }

  return false;
}

function parseToolInput(toolInput: unknown): unknown {
  if (typeof toolInput !== 'string') {
    return toolInput;
  }

  try {
    return JSON.parse(toolInput);
  } catch {
    return toolInput;
  }
}

function getToolInputPreview(message: ChatMessage): string {
  const config = getToolConfig(message.toolName || 'UnknownTool').input;
  const parsedInput = parseToolInput(message.toolInput);
  const title = typeof config.title === 'function' ? config.title(parsedInput) : config.title;
  const value = config.getValue?.(parsedInput);

  return String(value || title || message.displayText || message.content || '').trim();
}

/**
 * Builds the collapsed group's summary line.
 *
 * Computed here rather than in the component so it happens once per grouping
 * pass instead of once per group render. It is not cached beyond that: grouping
 * re-runs on every 100ms stream tick because visibleMessages is a fresh array,
 * and a run's preview changes as the run grows, so a cache would have to be
 * keyed on the whole run. Measured at 0.18ms per tick over a 100-message window,
 * which is a seventh of what the store's own per-tick merge costs — not worth
 * the staleness risk.
 */
function buildGroupPreview(messages: ChatMessage[]): string {
  const named = messages
    .slice(0, PREVIEWED_TOOL_COUNT)
    .map(getToolInputPreview)
    .filter(Boolean);

  const previewText = named.join(', ');
  // Subtracted from the previews actually printed, not from the two slots the
  // line reserves, so that named + extraCount === messages.length for every
  // input. A tool whose input yields no text — a Read with no file_path, an
  // input still arriving as partial JSON — is genuinely not named, so it
  // belongs in the remainder. Counting slots instead makes a group of three
  // whose first preview is empty render "/b.ts, +1 more" beside an x3 badge.
  const extraCount = messages.length - named.length;

  if (!previewText) {
    return extraCount > 0 ? `+${extraCount} more` : '';
  }

  return extraCount > 0 ? `${previewText}, +${extraCount} more` : previewText;
}

/**
 * Summary line for a run that spans several tools: each tool once, in order of
 * first use, with how many times it ran — "Bash ×3, Read ×2, Edit". Individual
 * inputs would be noise here; the breakdown is what tells the reader what kind
 * of work the collapsed row stands for.
 */
function buildMixedGroupPreview(messages: ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const label = getToolGroupLabel(message.toolName || 'UnknownTool');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return Array.from(counts, ([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(', ');
}

export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isGroupableToolMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // Skip invisible interleaved messages so they don't break the run.
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      // Any worker tool extends the run: a Bash, Read, Grep, Edit sequence is
      // one stretch of work, and showing it as four cards is what buried the
      // conversation under tool chrome.
      if (isGroupableToolMessage(candidate)) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      // A short narration beat announcing the next call doesn't break the run
      // — but only once lookahead confirms the same tool actually follows it.
      // Otherwise it's a genuine wrap-up comment and must end the run.
      if (
        isCaptionCandidate(candidate) &&
        isFollowedByMoreTools(messages, nextIndex + 1, showThinking)
      ) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      break;
    }

    // Captions absorbed into the run aren't tool calls — the badge, preview,
    // and grouping threshold all count only the calls themselves, so a caption
    // never pads a run of one real tool call past the threshold on its own.
    const toolMessages = run.filter(isGroupableToolMessage);

    if (toolMessages.length >= TOOL_GROUP_THRESHOLD) {
      const isMixed = toolMessages.some((candidate) => candidate.toolName !== message.toolName);
      items.push({
        _isGroup: true,
        toolName: message.toolName,
        isMixed,
        messages: run,
        timestamp: message.timestamp,
        toolCount: toolMessages.length,
        preview: isMixed ? buildMixedGroupPreview(toolMessages) : buildGroupPreview(toolMessages),
      });
    } else {
      items.push(...run);
    }

    index = nextIndex;
  }

  return items;
}
