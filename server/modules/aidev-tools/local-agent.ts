/**
 * remote_agent (F-09d): hand a task to an agent CLI installed on the user's PC — Claude Code, Codex or Gemini
 * CLI — when the job needs what only that PC has (its IDE/SDK/debuggers, a simulator, emulator, attached
 * device or board, a VPN) and the platform's own tools (remote_exec / remote_debug_* / remote_console_*) are
 * not enough. The CLI runs headless in the target folder under the user's own login on that PC, through the
 * runner's exec stream (the task goes in on stdin, so no shell quoting on any OS) and the approval gate: a
 * full-permission run is always asked. Its JSON event stream is parsed into the result, the steps it took
 * and the session id to continue it.
 */
export const LOCAL_AGENTS = ['claude', 'codex', 'gemini'] as const;
export type LocalAgent = (typeof LOCAL_AGENTS)[number];
export type LocalAgentMode = 'full' | 'readonly';

/** Which agent CLI to use: the requested one, else the first installed (runner capabilities.tools). */
export function pickLocalAgent(requested: string | undefined, tools: Record<string, string> | null | undefined): LocalAgent | null {
  const installed = LOCAL_AGENTS.filter((a) => Boolean(tools?.[a]));
  if (requested && requested !== 'auto') return (LOCAL_AGENTS as readonly string[]).includes(requested) ? requested as LocalAgent : null;
  return installed[0] ?? null;
}

const ID = /^[\w.:-]{4,100}$/;
const MODEL = /^[\w.:/-]{1,80}$/;

/** The command line (flags only — the task goes in on stdin). */
export function localAgentCommand(agent: LocalAgent, mode: LocalAgentMode, opts: { resume?: string; model?: string } = {}) {
  if (opts.resume && !ID.test(opts.resume)) throw new Error('resume: a session id from an earlier remote_agent result');
  if (opts.model && !MODEL.test(opts.model)) throw new Error('model: a model name');
  const model = opts.model ? ` --model ${opts.model}` : '';
  switch (agent) {
    case 'claude':
      // -p without a prompt argument reads the prompt from stdin
      return `claude -p --output-format stream-json --verbose ${mode === 'full' ? '--permission-mode acceptEdits --allowedTools Bash' : '--permission-mode plan'}${model}${opts.resume ? ` --resume ${opts.resume}` : ''}`;
    case 'codex': {
      // `-` = instructions from stdin
      const flags = `--json --skip-git-repo-check --sandbox ${mode === 'full' ? 'danger-full-access' : 'read-only'}${opts.model ? ` -m ${opts.model}` : ''}`;
      return opts.resume ? `codex exec ${flags} resume ${opts.resume} -` : `codex exec ${flags} -`;
    }
    case 'gemini':
      if (opts.resume) throw new Error('gemini: 이전 세션 이어가기(resume)는 지원하지 않습니다 — 새 작업으로 보내세요');
      // -p = headless, appended to the task on stdin; --skip-trust: an untrusted folder would drop yolo back to default
      return `gemini -p "Do the task described above." --output-format json --skip-trust --approval-mode ${mode === 'full' ? 'yolo' : 'plan'}${model}`;
    default:
      throw new Error(`unknown agent ${String(agent)}`);
  }
}

/** The task as the local agent reads it: where it runs, why, and how to report. */
export function localAgentPrompt(task: string, ctx: { machine: string; platform: string | null; cwd: string | null; mode: LocalAgentMode; resume: boolean }) {
  if (ctx.resume) return task;
  return [
    `[Nado AI Dev → 이 PC의 로컬 agent 위임]`,
    `너는 사용자의 PC "${ctx.machine}"(${ctx.platform ?? '알 수 없는 OS'})에서 실행 중이다. 클라우드 쪽 개발 agent가 이 PC에서만 할 수 있는 일을 맡겼다 — 이 PC의 IDE·SDK·디버거·시뮬레이터/에뮬레이터·연결된 기기와 보드를 직접 써라.`,
    ctx.mode === 'full'
      ? '추측하지 말고 실행·빌드·디버거(중단점, 변수, 스택)로 확인하고, 필요하면 코드를 고친 뒤 다시 실행해 검증하라. 이 폴더 밖의 파일·시스템 설정은 바꾸지 마라.'
      : '읽기 전용이다: 파일을 바꾸거나 명령을 실행하지 말고 코드와 설정을 읽어 분석만 하라.',
    ctx.cwd ? `작업 폴더: ${ctx.cwd}` : '',
    '',
    '작업:',
    task.trim(),
    '',
    '끝나면 짧게 보고하라: 결론(원인) · 근거(실행한 명령, 디버거에서 본 값) · 바꾼 파일 · 검증 결과 · 남은 문제.',
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

export type LocalAgentReport = {
  agent: LocalAgent | 'unknown'; sessionId: string | null; result: string | null; isError: boolean; error: string | null;
  steps: string[]; turns: number | null; costUsd: number | null; durationMs: number | null;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
function stepOf(name: string, input: Record<string, unknown>) {
  const detail = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? '';
  return clip(`${name}${detail ? `: ${String(detail).replace(/\s+/g, ' ')}` : ''}`, 200);
}

/** Parses the agent CLI's output (claude stream-json / codex exec --json / gemini json; partial tails allowed). */
export function parseLocalAgentOutput(text: string, hint?: LocalAgent): LocalAgentReport {
  const r: LocalAgentReport = { agent: hint ?? 'unknown', sessionId: null, result: null, isError: false, error: null, steps: [], turns: null, costUsd: null, durationMs: null };
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) continue;
    try { events.push(JSON.parse(t) as Record<string, unknown>); } catch { /* a cut line */ }
  }
  let lastText: string | null = null;
  let codexError: string | null = null;
  for (const e of events) {
    const type = String(e.type ?? '');
    // Claude Code stream-json
    if (type === 'system' || type === 'assistant' || type === 'user' || type === 'result') {
      r.agent = 'claude';
      if (typeof e.session_id === 'string') r.sessionId = e.session_id;
      if (type === 'assistant') {
        const content = ((e.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
        for (const c of content) {
          if (c.type === 'tool_use') r.steps.push(stepOf(String(c.name), (c.input ?? {}) as Record<string, unknown>));
          else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) lastText = c.text;
        }
      }
      if (type === 'result') {
        if (typeof e.result === 'string') r.result = e.result;
        r.isError = e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success');
        if (r.isError) r.error = typeof e.result === 'string' && e.result ? e.result : String(e.subtype ?? 'error');
        if (typeof e.num_turns === 'number') r.turns = e.num_turns;
        if (typeof e.total_cost_usd === 'number') r.costUsd = e.total_cost_usd;
        if (typeof e.duration_ms === 'number') r.durationMs = e.duration_ms;
      }
      continue;
    }
    // Codex exec --json (thread/item events; older builds: {msg:{type,…}})
    if (type.startsWith('thread.') || type.startsWith('item.') || type.startsWith('turn.') || type === 'error' || e.msg) {
      r.agent = 'codex';
      if (type === 'thread.started' && typeof e.thread_id === 'string') r.sessionId = e.thread_id;
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (type === 'item.completed') {
        const it = String(item.type ?? item.item_type ?? '');
        if ((it === 'agent_message' || it === 'assistant_message') && typeof item.text === 'string') lastText = item.text;
        else if (it === 'command_execution') r.steps.push(clip(`$ ${String(item.command ?? '')}${typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : ''}`, 200));
        else if (it === 'file_change') r.steps.push(clip(`파일 변경: ${((item.changes ?? []) as Array<{ path?: string }>).map((c) => c.path).filter(Boolean).join(', ')}`, 200));
        else if (it === 'mcp_tool_call' || it === 'web_search') r.steps.push(clip(`${it}: ${String(item.tool ?? item.query ?? '')}`, 200));
      }
      // `error` events include transient ones ("Reconnecting... 2/5"); only turn.failed ends the run
      if (type === 'error') codexError = String(e.message ?? 'error');
      if (type === 'turn.failed') { r.isError = true; r.error = String((e.error as { message?: string } | undefined)?.message ?? codexError ?? 'turn failed'); }
      if (type === 'turn.completed') codexError = null;
      const msg = e.msg as Record<string, unknown> | undefined;
      if (msg) {
        if (msg.type === 'session_configured' && typeof msg.session_id === 'string') r.sessionId = msg.session_id;
        if (msg.type === 'agent_message' && typeof msg.message === 'string') lastText = msg.message;
        if (msg.type === 'exec_command_begin') r.steps.push(clip(`$ ${[].concat((msg.command ?? []) as never).join(' ')}`, 200));
        if (msg.type === 'error') { r.isError = true; r.error = String(msg.message ?? 'error'); }
      }
      continue;
    }
    // Gemini CLI --output-format json: one object {response, stats, error?}
    if ('response' in e || ('stats' in e && 'error' in e)) {
      r.agent = 'gemini';
      if (typeof e.response === 'string') r.result = e.response;
      const err = e.error as { message?: string } | null | undefined;
      if (err) { r.isError = true; r.error = String(err.message ?? 'error'); }
    }
  }
  // gemini pretty-prints its JSON over several lines
  if (!events.length || (hint === 'gemini' && r.result === null)) {
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        if (typeof o.response === 'string') { r.agent = 'gemini'; r.result = o.response; }
        const err = o.error as { message?: string } | null | undefined;
        if (err) { r.isError = true; r.error = String(err.message ?? 'error'); }
      } catch { /* not one JSON object */ }
    }
  }
  if (r.result === null) r.result = lastText;
  if (r.agent === 'codex' && r.result === null && codexError && !r.isError) { r.isError = true; r.error = codexError; }
  r.steps = r.steps.slice(-20);
  return r;
}
