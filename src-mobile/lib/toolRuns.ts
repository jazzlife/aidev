import type { NormalizedMessage } from '@/modules/chat-core';

/**
 * Collapsing a stretch of tool calls into one row (2026-10-09): the chat was a wall of Bash / PowerShell /
 * Read cards, and the prose between them could not be followed. The workbench folds consecutive worker
 * tools into one expandable row (src/modules/chat/utils/toolGrouping.ts); this is the same rule on the
 * phone's message model.
 */
export type ToolRun = { kind: 'tool_run'; id: string; messages: NormalizedMessage[]; toolCount: number };
export type TranscriptRow = NormalizedMessage | ToolRun;

/** Tools whose card speaks to the user (a checklist, a plan, a question, a subagent's report): their own row, never folded. */
const STANDALONE_TOOLS = new Set(['TodoWrite', 'update_plan', 'todo_list', 'Task', 'Agent', 'ExitPlanMode', 'exit_plan_mode', 'AskUserQuestion']);
/** How many tool calls make a run worth folding. */
const RUN_THRESHOLD = 2;
/** Longest one-line assistant text that still reads as narration before the next call, not an explanation. */
const CAPTION_MAX_LENGTH = 100;

export function isToolRun(row: TranscriptRow): row is ToolRun {
  return (row as ToolRun).kind === 'tool_run';
}

/** A worker tool call: anything but the user-facing cards. */
export function isWorkerTool(message: NormalizedMessage): boolean {
  return message.kind === 'tool_use' && !STANDALONE_TOOLS.has(message.toolName ?? '');
}

// a short single-line assistant sentence between two calls is narration of the next call, not prose to keep apart
function isCaption(message: NormalizedMessage): boolean {
  if (message.kind !== 'text' || message.role === 'user') return false;
  const text = (message.content ?? '').trim();
  if (!text || text.length > CAPTION_MAX_LENGTH || text.includes('\n')) return false;
  return (text.match(/[.!?](?:\s|$)/g) ?? []).length <= 1;
}

// hidden-by-default rows (reasoning) never split a run
const rendersQuietly = (message: NormalizedMessage) => message.kind === 'thinking';

function followedByWorkerTool(rows: NormalizedMessage[], from: number): boolean {
  for (let index = from; index < rows.length; index += 1) {
    const candidate = rows[index];
    if (rendersQuietly(candidate) || isCaption(candidate)) continue;
    return isWorkerTool(candidate);
  }
  return false;
}

/**
 * Used by MessageList: the rendered rows with every stretch of two or more worker tool calls folded into one
 * ToolRun. Reasoning and one-line captions inside a stretch ride along (shown when the row is expanded);
 * real prose, a user turn, an error or a user-facing card ends the stretch.
 */
export function groupToolRuns(rows: NormalizedMessage[]): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const message = rows[index];
    if (!isWorkerTool(message)) { out.push(message); index += 1; continue; }
    const run: NormalizedMessage[] = [message];
    let next = index + 1;
    while (next < rows.length) {
      const candidate = rows[next];
      if (isWorkerTool(candidate) || rendersQuietly(candidate)) { run.push(candidate); next += 1; continue; }
      if (isCaption(candidate) && followedByWorkerTool(rows, next + 1)) { run.push(candidate); next += 1; continue; }
      break;
    }
    // trailing reasoning belongs to what comes after the run, not inside it
    while (run.length > 1 && rendersQuietly(run[run.length - 1])) { run.pop(); next -= 1; }
    const toolCount = run.filter(isWorkerTool).length;
    if (toolCount >= RUN_THRESHOLD) out.push({ kind: 'tool_run', id: `run:${message.id}`, messages: run, toolCount });
    else out.push(...run);
    index = next;
  }
  return out;
}

/** "Bash 3 · Read 2 · Edit" — each tool once, in order of first use, with how many times it ran. */
export function describeToolRun(run: ToolRun): string {
  const counts = new Map<string, number>();
  for (const message of run.messages) if (isWorkerTool(message)) counts.set(message.toolName ?? '도구', (counts.get(message.toolName ?? '도구') ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ${count}` : name)).join(' · ');
}
