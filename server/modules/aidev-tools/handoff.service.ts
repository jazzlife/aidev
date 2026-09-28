/**
 * Engine handoff (IMPLEMENTATION-PLAN §3.8, E-03): when a failed run moves to the other engine, the
 * new session starts from a compact brief of the old one — original and latest request, files the
 * old session changed, commands it ran, the last errors and its last answer. Built from the
 * transcript without a model call, so it costs nothing and is reproducible.
 */
export type HandoffInput = { sessionId: string; fromEngine: string | null; toEngine: string | null; reason: string | null };

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit', 'write']);
const COMMAND_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell']);

function clip(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function inputOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { const parsed = JSON.parse(raw) as unknown; return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
  return {};
}

type HistoryMessage = { kind: string; role?: string; content?: string; text?: string; toolName?: string; toolInput?: unknown; toolResult?: { isError?: boolean; content?: unknown } | null };

/** Pure part of the brief (exported for tests): transcript messages → handoff text. */
export function buildHandoffBrief(messages: HistoryMessage[], input: Omit<HandoffInput, 'sessionId'>): { text: string; files: string[]; userTurns: number } {
  const userTexts: string[] = []; const files = new Set<string>(); const commands: string[] = []; const errors: string[] = [];
  let lastAssistant = '';
  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'user' && message.content) userTexts.push(message.content);
    else if (message.kind === 'text' && message.role === 'assistant' && message.content) lastAssistant = message.content;
    else if (message.kind === 'tool_use' && message.toolName) {
      const args = inputOf(message.toolInput);
      if (FILE_TOOLS.has(message.toolName) && typeof (args.file_path ?? args.path) === 'string') files.add(String(args.file_path ?? args.path));
      if (COMMAND_TOOLS.has(message.toolName) && (typeof args.command === 'string' || Array.isArray(args.command))) commands.push(clip(Array.isArray(args.command) ? args.command.join(' ') : args.command, 160));
    } else if ((message.kind === 'tool_result' && message.toolResult?.isError) || message.kind === 'error') {
      errors.push(clip(message.kind === 'error' ? (message.content ?? message.text) : message.toolResult?.content, 300));
    }
  }
  const first = userTexts[0] ?? '(알 수 없음)';
  const latest = userTexts[userTexts.length - 1] ?? first;
  const lines = [
    `[인계] 이어받은 작업${input.fromEngine && input.toEngine ? ` (${input.fromEngine} → ${input.toEngine})` : ''}`,
    input.reason ? `넘긴 이유: ${input.reason}` : null,
    `원래 요청: ${clip(first, 1500)}`,
    latest !== first ? `마지막 요청: ${clip(latest, 1500)}` : null,
    files.size ? `이전 세션이 수정한 파일: ${[...files].slice(-20).join(', ')}` : '이전 세션이 수정한 파일: 없음',
    commands.length ? `이전 세션이 실행한 명령(최근):\n${commands.slice(-6).map((c) => `- ${c}`).join('\n')}` : null,
    errors.length ? `최근 오류:\n${errors.slice(-3).map((e) => `- ${e}`).join('\n')}` : null,
    lastAssistant ? `이전 세션의 마지막 응답(발췌):\n${clip(lastAssistant, 1200)}` : null,
    '지시: 이전 세션은 위 작업에 실패했다. 먼저 현재 파일 상태를 직접 확인한 뒤, 원래 요청을 끝까지 완료하라. 같은 실패를 반복하지 않도록 다른 접근을 우선 검토하라.',
  ].filter((line): line is string => line !== null);
  // blank lines keep each part its own paragraph when the brief is rendered as markdown
  return { text: lines.join('\n\n'), files: [...files], userTurns: userTexts.length };
}

/** Used by aidev-tools.routes.ts (`POST /handoff`). */
export const handoffService = {
  async build(input: HandoffInput): Promise<{ text: string; files: string[]; userTurns: number }> {
    // Lazy: the providers module imports this module's barrel (see lesson-curator.service.ts).
    const { sessionsService } = await import('@/modules/providers/index.js');
    const history = await sessionsService.fetchHistory(input.sessionId, { limit: 400, offset: 0 });
    return buildHandoffBrief(history.messages as HistoryMessage[], input);
  },
};
