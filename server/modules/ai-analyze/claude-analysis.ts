import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { claudeCliModel } from '@/shared/index.js';
import type { AiAnalyzeFailure, AiAnalyzeTurnRequest, AiAnalyzeTurnResult } from '@/shared/types.js';

/**
 * One analysis turn on the account's Claude subscription (the runtime's Claude sign-in), shaped like the specialist
 * judge's side turn: no tools, one turn, no settings or memory files, nothing written to the chat history
 * (`persistSession: false`), an empty working folder. Each input goes to the model as a content block — a PDF or a
 * text file as a `document`, an image as an `image` — after a line naming it, so the model reads it itself (without a
 * Read tool) and the task can refer to each input by name. The caller's data is in the prompt, after the inputs.
 * Verified on 2026-11-16: a PDF and a text document each came back with the word only they contained.
 *
 * Each call starts its own CLI process: it shares nothing with the chats' processes or the judge's warm one.
 * The account's usage-limit state is not written from here — an analysis never changes how chats are routed.
 */

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const EMPTY_DIR = path.join(os.tmpdir(), 'aidev-ai-analyze');

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } | { type: 'text'; media_type: 'text/plain'; data: string } };

/** The inputs, each after a line naming it, then the task. Exported for this module's tests. */
export function contentFor(request: AiAnalyzeTurnRequest): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  request.inputs.forEach((input, index) => {
    blocks.push({ type: 'text', text: `[input ${index + 1}/${request.inputs.length}: ${input.name} (${input.mime})]` });
    if (input.mime === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: input.bytes.toString('base64') } });
    else if (input.mime === 'text/plain') blocks.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: input.bytes.toString('utf8') } });
    else blocks.push({ type: 'image', source: { type: 'base64', media_type: input.mime, data: input.bytes.toString('base64') } });
  });
  blocks.push({ type: 'text', text: request.prompt });
  return blocks;
}

type RateLimitInfo = { status?: string; overageStatus?: string; resetsAt?: number; rateLimitType?: string };

/**
 * A failed turn as a contract failure. `rejected` is the usage window that refused the turn, when the SDK reported one.
 * Exported for this module's tests.
 */
export function classifyTurnFailure(message: string, apiStatus: number | null, rejected: RateLimitInfo | null, timedOut: boolean): AiAnalyzeFailure {
  if (timedOut) return { status: 504, code: 'timeout', message: '분석이 시간 안에 끝나지 않아 멈췄다. 입력을 줄이거나(목차만 보내기) 잠시 후 다시 보내라' };
  if (rejected || apiStatus === 429 || /usage limit|rate limit/i.test(message)) {
    const raw = Number(rejected?.resetsAt);
    const resetsAt = Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : null;
    const retryAfterSec = resetsAt ? Math.max(1, Math.ceil((resetsAt - Date.now()) / 1000)) : 60;
    return { status: 429, code: 'rate_limited', retryAfterSec,
      message: `이 NadoVibe 계정의 Claude 구독 사용량 한도에 걸렸다${resetsAt ? ` — ${new Date(resetsAt).toISOString()} 에 풀린다` : ''}. 그때 같은 requestId 로 다시 보내라` };
  }
  if (apiStatus === 401 || apiStatus === 403 || /\/login|not logged in|authenticat|invalid api key|oauth/i.test(message)) {
    return { status: 502, code: 'upstream_error', message: '이 NadoVibe 계정의 Claude 로그인이 없거나 만료됐다. NadoVibe 설정에서 Claude 에 다시 로그인하라' };
  }
  if (apiStatus === 413 || /prompt is too long|too many (pages|tokens)|request too large|exceeds? .*(limit|maximum)/i.test(message)) {
    return { status: 413, code: 'too_large', message: '입력이 모델이 한 번에 읽을 수 있는 양을 넘는다. 쪽수를 줄이거나 목차만 보내는 모드를 써라' };
  }
  if (/pdf|image|media|document|decode/i.test(message) && (apiStatus === 400 || apiStatus === null)) {
    return { status: 415, code: 'unsupported_media', message: `모델이 입력 파일을 열지 못했다 (${message.slice(0, 200)}). 손상되지 않은 PDF·PNG·JPEG·텍스트로 다시 보내라` };
  }
  return { status: 502, code: 'upstream_error', message: `모델 호출이 실패했다: ${message.slice(0, 300) || '이유를 알 수 없음'}. 잠시 후 같은 requestId 로 다시 보내라` };
}

/** Runs one analysis turn. Used by the ai-analyze module's composition root as the service's model turn. */
export async function runClaudeAnalysisTurn(request: AiAnalyzeTurnRequest): Promise<AiAnalyzeTurnResult> {
  const started = Date.now();
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, request.timeoutMs);
  let rejected: RateLimitInfo | null = null;
  let answeredBy: string | null = null;
  try {
    fs.mkdirSync(EMPTY_DIR, { recursive: true });
    const content = contentFor(request);
    async function* input() {
      yield { type: 'user' as const, message: { role: 'user' as const, content }, parent_tool_use_id: null, session_id: '' };
    }
    const stream = query({
      prompt: input() as Parameters<typeof query>[0]['prompt'],
      options: {
        cwd: EMPTY_DIR, maxTurns: 1, model: claudeCliModel(request.model),
        ...(request.effort && EFFORTS.has(request.effort) ? { effort: request.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
        allowedTools: [], tools: [], permissionMode: 'bypassPermissions', systemPrompt: request.system,
        settingSources: [], persistSession: false, abortController,
      },
    });
    for await (const message of stream) {
      const record = message as { type?: string; rate_limit_info?: RateLimitInfo; message?: { model?: string } };
      if (record.type === 'rate_limit_event') {
        const info = record.rate_limit_info ?? {};
        // a window that refuses the account (overage not covering it) — same rule as the chat runtime
        if (info.status === 'rejected' && info.overageStatus !== 'allowed' && info.overageStatus !== 'allowed_warning') rejected = info;
        else if (info.status === 'allowed' || info.status === 'allowed_warning') rejected = null;
      }
      if (record.type === 'assistant' && typeof record.message?.model === 'string') answeredBy = record.message.model;
      if (message.type !== 'result') continue;
      const text = 'result' in message && typeof message.result === 'string' ? message.result : '';
      if (message.subtype === 'success' && !message.is_error && text.trim()) {
        return { ok: true, text, model: answeredBy ?? request.model, sessionId: message.session_id ?? null,
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null, durationMs: Date.now() - started };
      }
      const apiStatus = 'api_error_status' in message && typeof message.api_error_status === 'number' ? message.api_error_status : null;
      const reason = text || ('errors' in message && Array.isArray(message.errors) ? message.errors.join('; ') : '') || message.subtype;
      return { ok: false, failure: classifyTurnFailure(reason, apiStatus, rejected, timedOut) };
    }
    return { ok: false, failure: classifyTurnFailure('the model ended without an answer', null, rejected, timedOut) };
  } catch (error) {
    return { ok: false, failure: classifyTurnFailure(error instanceof Error ? error.message : String(error), null, rejected, timedOut) };
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}
