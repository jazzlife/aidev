import os from 'node:os';

import { callGateway } from '@/modules/aidev-tools/aidev-tools.service.js';
import { askOpenCodeSideTurn } from '@/modules/aidev-tools/opencode-side-turn.client.js';

/**
 * OpenCode as a sub-agent of the chat's worker (2026-10-16: OpenCode is for verification and sub-agent work). The
 * worker — Claude or Codex — hands a self-contained piece (a survey of the code, tests for a module, a review, an edit
 * of named files) to OpenCode through the `opencode_task` platform tool, waits for its report and goes on. It runs in
 * the chat's project on the model the account's OpenCode range picks for the stated difficulty, as a side turn (no
 * chat of its own). Nothing here sits on a send's path: a router or a judge never waits for OpenCode.
 */
export type OpenCodeTaskInput = {
  task: string;
  /** 'read': OpenCode's plan agent, no edits and no writing commands; 'edit': every permission inside the project. */
  mode: 'read' | 'edit';
  /** How hard the piece is (0–4): the range of the account's OpenCode picks model and effort from it. */
  depth?: number;
  timeoutSec?: number;
};
export type OpenCodeTaskTurn = { cwd?: string | null; agent?: string | null };

const DEFAULT_DEPTH = 2;
const DEFAULT_TIMEOUT_SEC = 15 * 60;
const MAX_TIMEOUT_SEC = 40 * 60;
const REPORT_CHARS = 20_000;

const SUBAGENT_RULES = `당신은 다른 개발 agent가 맡긴 하위 작업을 수행하는 서브에이전트다.
- 맡긴 범위의 일만 한다. 범위 밖의 파일·설정은 바꾸지 않는다. 파괴적 명령(삭제, reset, push, 배포, 설치)은 실행하지 않는다.
- 추측하지 말고 파일을 읽고 명령을 실행해 확인한다.
- 끝나면 맡긴 agent가 바로 이어서 쓸 수 있게 짧게 보고한다: 결론 · 근거(읽은 파일, 실행한 명령과 결과) · 바꾼 파일 · 남은 문제.`;

type PolicyEntry = { allowed?: boolean; preview?: Array<{ model?: string; effort?: string | null } | null> };

/** What runOpenCodeTask reads and starts; its test replaces them. */
type OpenCodeTaskDeps = {
  readPolicy: () => Promise<{ providers?: Record<string, PolicyEntry> }>;
  /** OpenCode's usage-limit hold from the drawer's picture (null: none) */
  heldUntil: () => Promise<number | null | undefined>;
  ask: typeof askOpenCodeSideTurn;
};
const defaultDeps: OpenCodeTaskDeps = {
  readPolicy: async () => await callGateway('GET', '/settings/provider-policy') as { providers?: Record<string, PolicyEntry> },
  // lazy: the providers module imports this module's barrel (see lesson-curator.service.ts)
  heldUntil: async () => (await import('@/modules/providers/index.js')).providerUsageLimitsService.snapshot().opencode?.blockedUntil,
  ask: askOpenCodeSideTurn,
};

/** Used by aidev-tools-mcp.routes.ts (`opencode_task`): runs the piece on OpenCode and returns its report. */
export async function runOpenCodeTask(input: OpenCodeTaskInput, turn: OpenCodeTaskTurn = {}, deps: OpenCodeTaskDeps = defaultDeps) {
  // the account's OpenCode: switched on, and its range's pick for the piece's difficulty
  const policy = await deps.readPolicy();
  const entry = policy.providers?.opencode;
  if (!entry?.allowed) return { status: 'unavailable', message: '이 계정은 OpenCode를 쓰도록 켜져 있지 않습니다 — 설정 → OpenCode → 모델·강도 범위에서 켤 수 있습니다. 이 작업은 직접 하세요.' };
  // OpenCode refusing on a usage limit right now: no turn is started only to be refused again
  const held = await deps.heldUntil();
  if (held !== null && held !== undefined) return { status: 'limited', message: `OpenCode가 사용량 한도에 걸려 있습니다${held > 0 ? ` (해제 ${new Date(held).toISOString()})` : ''} — 이 작업은 직접 하세요.` };
  const depth = Math.max(0, Math.min(4, Math.round(input.depth ?? DEFAULT_DEPTH)));
  const pick = entry.preview?.[depth] ?? null;
  const model = typeof pick?.model === 'string' ? pick.model : null;
  const effort = typeof pick?.effort === 'string' ? pick.effort : null;
  const timeoutSec = Math.min(Math.max(Math.round(input.timeoutSec ?? DEFAULT_TIMEOUT_SEC), 30), MAX_TIMEOUT_SEC);
  const started = Date.now();
  try {
    const report = await deps.ask({
      label: `subagent${turn.agent ? ` for ${turn.agent}` : ''}`,
      instructions: SUBAGENT_RULES,
      prompt: input.task,
      cwd: turn.cwd || os.homedir(),
      model, effort,
      access: input.mode === 'read' ? 'read' : 'check',
      timeoutMs: timeoutSec * 1000,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`[aidev-tools] opencode_task ${input.mode} D${depth} on ${model ?? '(default)'}${effort ? `/${effort}` : ''} for ${turn.agent ?? '-'}: done in ${seconds}s`);
    return { status: 'done', engine: 'opencode', model, effort, seconds, report: report.length > REPORT_CHARS ? `…${report.slice(-REPORT_CHARS)}` : report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[aidev-tools] opencode_task ${input.mode} D${depth} for ${turn.agent ?? '-'} failed: ${message}`);
    return { status: 'failed', engine: 'opencode', model, effort, message: `${message} — 이 작업은 직접 하세요.` };
  }
}
