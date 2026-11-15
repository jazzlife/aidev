import { createHash, randomBytes } from 'node:crypto';

import type { AiAnalyzeFailure, AiAnalyzeInput, AiAnalyzeModelPick, AiAnalyzeReply, AiAnalyzeTurnRequest, AiAnalyzeTurnResult } from '@/shared/types.js';
import { checkSchema, extractJson, schemaSketch, validateAgainstSchema } from '@/modules/ai-analyze/output-schema.js';
import type { createAnalysisResultsStore } from '@/modules/ai-analyze/analysis-results.store.js';

/**
 * The AI analysis contract v1 (`POST /ai/v1/analyze`, `GET /ai/v1/analyze/{jobId}`) on this runtime: one tool-less
 * model turn on the account's Claude subscription, answered in the shape the caller's `output.schema` declares.
 *
 * - Every request the engine cannot serve is refused at once (400/409/413/415/422/429), before a job exists.
 * - An accepted request always becomes a job (202): an analysis takes minutes, longer than the CDN waits for a reply.
 * - Idempotency (§3.1): the same `requestId` with the same body returns the stored answer without calling the model
 *   (`costUsd: 0`); with another body it is a 409. Only successes are kept; a failure is tried again.
 * - One analysis at a time per runtime (= per account), a short queue behind it, so analyses cannot crowd out the
 *   account's own chats; past the queue the caller is asked to come back (429).
 */

const READABLE = new Set<AiAnalyzeInput['mime']>(['application/pdf', 'image/png', 'image/jpeg', 'text/plain']);
/**
 * Input limits (decoded bytes). A Claude request takes at most 32 MB, and a PDF travels base64-encoded (4/3 larger):
 * 22 MiB of PDF is ~29.3 MiB on the wire with room left for the prompt. An image block takes at most 5 MB. A text file
 * (DXF) is read as tokens: past ~1 MiB it no longer fits the model's context.
 */
const MAX_BYTES: Record<AiAnalyzeInput['mime'], number> = {
  'application/pdf': 22 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'image/jpeg': 5 * 1024 * 1024,
  'text/plain': 1024 * 1024,
};
const MAX_TEXT_CHARS = 500_000;
/** Kept at least 24 h (§3.1); 48 h so a retry on the next working day still finds its answer. */
const KEEP_MS = 48 * 3600_000;
const POLL_AFTER_MS = 2000;
const JOB_ID = /^job_[0-9a-f]{16}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Body = Record<string, unknown>;
type Parsed = {
  requestId: string;
  system: string;
  prompt: string;
  effort: string | null;
  format: 'json' | 'text';
  schema: Body | null;
  schemaName: string | null;
  inputs: Array<{ name: string; mime: string; base64: string }>;
};
type Job = { parsed: Parsed; input: AiAnalyzeInput | null; jobId: string };

type Deps = {
  store: ReturnType<typeof createAnalysisResultsStore>;
  runTurn(request: AiAnalyzeTurnRequest): Promise<AiAnalyzeTurnResult>;
  pickModel(effortHint: string | null): Promise<AiAnalyzeModelPick>;
  now?: () => number;
  /** one model turn's limit; a schema retry gets its own */
  turnTimeoutMs?: number;
  /** analyses waiting behind the running one before callers are asked to come back */
  maxQueued?: number;
};

const failure = (status: number, code: string, message: string, extra: Partial<AiAnalyzeFailure> = {}): AiAnalyzeFailure => ({ status, code, message, ...extra });
const errorReply = (f: AiAnalyzeFailure, polled = false): AiAnalyzeReply => {
  const { status, ...error } = f;
  return { status, body: { ok: false, ...(polled ? { status: 'error' } : {}), error } };
};
const isObject = (value: unknown): value is Body => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown, max: number): string | null | undefined =>
  value === undefined || value === null ? null : typeof value === 'string' && value.length <= max ? value : undefined;

/** Key-order-independent JSON over the whole depth (§3.1: `JSON.stringify(v, keys)` would be an allowlist, not a sort). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Body)[key])}`).join(',')}}`;
}

/**
 * The request's fingerprint for idempotency: `task`, `output` and `inputs` (not `requestId`), the file contents hashed
 * as they stream in rather than copied into one more string. Exported for this module's tests.
 */
export function requestFingerprint(body: Body): string {
  const inputs = Array.isArray(body.inputs) ? body.inputs as unknown[] : [];
  const hash = createHash('sha256');
  hash.update(stableStringify({ task: body.task ?? null, output: body.output ?? null, inputs: inputs.map((input) => (isObject(input) ? { ...input, base64: undefined } : input)) }));
  for (const input of inputs) { hash.update('\0'); hash.update(isObject(input) && typeof input.base64 === 'string' ? input.base64 : ''); }
  return hash.digest('hex');
}

/** The request body → the parts the engine uses, or the contract failure that refuses it. */
function parseRequest(raw: unknown): Parsed | AiAnalyzeFailure {
  if (!isObject(raw)) return failure(400, 'bad_request', '본문이 JSON 객체가 아니다');
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : '';
  if (!requestId || requestId.length > 200) return failure(400, 'bad_request', 'requestId 가 필요하다 (1~200자 글자)');
  const task = isObject(raw.task) ? raw.task : null;
  if (!task || typeof task.system !== 'string' || !task.system.trim() || typeof task.prompt !== 'string' || !task.prompt.trim()) {
    return failure(400, 'bad_request', 'task.system 과 task.prompt 가 필요하다');
  }
  if (task.system.length > MAX_TEXT_CHARS || task.prompt.length > MAX_TEXT_CHARS) return failure(413, 'too_large', `task.system·task.prompt 는 각각 ${MAX_TEXT_CHARS}자 이하여야 한다. 목차를 줄여 다시 보내라`);
  const effort = optionalString(task.effort, 20);
  if (effort === undefined || optionalString(task.model, 100) === undefined) return failure(400, 'bad_request', 'task.model·task.effort 는 짧은 글자여야 한다');
  const output = raw.output === undefined ? { format: 'text' } : raw.output;
  if (!isObject(output) || (output.format !== 'json' && output.format !== 'text')) return failure(400, 'bad_request', 'output.format 은 "json" 또는 "text" 다');
  const schemaName = optionalString(output.schemaName, 200);
  if (schemaName === undefined) return failure(400, 'bad_request', 'output.schemaName 은 200자 이하 글자여야 한다');
  let schema: Body | null = null;
  if (output.format === 'json') {
    if (output.schema === undefined) return failure(400, 'bad_request', 'output.format 이 json 이면 output.schema 가 필요하다');
    const problems = checkSchema(output.schema);
    if (problems.length) return failure(422, 'schema_unsupported', `스키마를 못 읽는다: ${problems[0]}`, { details: problems });
    schema = output.schema as Body;
  }
  if (raw.inputs !== undefined && !Array.isArray(raw.inputs)) return failure(400, 'bad_request', 'inputs 는 배열이어야 한다');
  const list = (raw.inputs ?? []) as unknown[];
  if (list.length > 1) return failure(413, 'too_large', '이 엔진은 요청 하나에 입력 하나만 받는다. 파일을 하나씩 나눠 보내라');
  const inputs: Parsed['inputs'] = [];
  for (const item of list) {
    if (!isObject(item) || typeof item.mime !== 'string' || typeof item.base64 !== 'string') return failure(400, 'bad_request', 'inputs 의 항목에는 mime 과 base64 가 필요하다');
    inputs.push({ name: typeof item.name === 'string' ? item.name.slice(0, 255) : 'input', mime: item.mime, base64: item.base64 });
  }
  return { requestId, system: task.system, prompt: task.prompt, effort, format: output.format, schema, schemaName, inputs };
}

/** The one input, decoded and within its limits, or the failure that refuses it. */
function decodeInput(inputs: Parsed['inputs']): AiAnalyzeInput | null | AiAnalyzeFailure {
  const item = inputs[0];
  if (!item) return null;
  const mime = item.mime.toLowerCase().split(';')[0].trim() as AiAnalyzeInput['mime'];
  if (!READABLE.has(mime)) return failure(415, 'unsupported_media', `${item.mime} 는 읽지 못한다. PDF·PNG·JPEG·텍스트(DXF)만 받는다`);
  const base64 = item.base64.replace(/\s+/g, '');
  if (!base64 || base64.length % 4 !== 0 || !BASE64.test(base64)) return failure(400, 'bad_request', `${item.name} 의 base64 가 올바르지 않다 (줄바꿈 없는 표준 base64 여야 한다)`);
  const bytes = Buffer.from(base64, 'base64');
  const limit = MAX_BYTES[mime];
  if (bytes.length > limit) return failure(413, 'too_large', `${item.name} 이(가) ${(bytes.length / 1048576).toFixed(1)}MB 로, ${mime} 상한 ${(limit / 1048576).toFixed(0)}MB 를 넘는다. 목차만 보내는 모드로 낮춰라`);
  if (mime === 'application/pdf' && !bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) return failure(415, 'unsupported_media', `${item.name} 은(는) PDF 가 아니다 (%PDF- 머리가 없다)`);
  return { name: item.name, mime, bytes };
}

/** The prompt the model gets: the caller's task, then — for JSON — the declared shape it must answer in. */
function promptFor(parsed: Parsed, retry?: { errors: string[]; previous: string }): string {
  if (parsed.format === 'text' || !parsed.schema) return parsed.prompt;
  const parts = [
    parsed.prompt,
    '# 출력 형식',
    'Reply with exactly ONE JSON value and nothing else — no prose, no markdown fence. It must satisfy this JSON Schema:',
    JSON.stringify(parsed.schema),
    'Shape at a glance:',
    schemaSketch(parsed.schema),
  ];
  if (retry) {
    parts.push('# 앞선 답이 스키마에 맞지 않았다', ...retry.errors.slice(0, 20).map((line) => `- ${line}`),
      'Previous reply:', retry.previous.slice(0, 4000), 'Answer again with the corrected JSON value only.');
  }
  return parts.join('\n\n');
}

/**
 * The analysis service over its store, model turn and model pick. Used by the ai-analyze module's composition root;
 * tests build it with an in-memory store and handwritten turns.
 */
export function createAiAnalyzeService(deps: Deps) {
  const now = deps.now ?? Date.now;
  const turnTimeoutMs = deps.turnTimeoutMs ?? 10 * 60_000;
  const maxQueued = deps.maxQueued ?? 2;
  /** jobs of this process: the running one and the queue (a running row without one here was cut by a restart) */
  const live = new Set<string>();
  const queue: Job[] = [];
  let running = false;

  async function runJob(job: Job): Promise<void> {
    const { parsed, input, jobId } = job;
    const finished = (f: AiAnalyzeFailure) => deps.store.fail(jobId, f, now());
    const pick = await deps.pickModel(parsed.effort);
    if (!pick.ok) return finished(pick.failure);
    const turn = (prompt: string) => deps.runTurn({ system: parsed.system, prompt, input, model: pick.model, effort: pick.effort, timeoutMs: turnTimeoutMs });
    let answer = await turn(promptFor(parsed));
    if (!answer.ok) return finished(answer.failure);
    let cost = answer.costUsd;
    let data: unknown;
    if (parsed.format === 'json' && parsed.schema) {
      const check = (text: string) => { const value = extractJson(text); return { value, errors: value === undefined ? ['$: 답에서 JSON 을 찾지 못했다'] : validateAgainstSchema(parsed.schema!, value) }; };
      let checked = check(answer.text);
      if (checked.errors.length) {
        // one corrective turn (§3.3 step 3): the model sees what was wrong with its answer
        const again = await turn(promptFor(parsed, { errors: checked.errors, previous: answer.text }));
        if (!again.ok) return finished(again.failure);
        cost = cost === null && again.costUsd === null ? null : (cost ?? 0) + (again.costUsd ?? 0);
        answer = again;
        checked = check(again.text);
      }
      if (checked.errors.length) {
        return finished(failure(422, 'schema_mismatch', `모델의 답을 스키마에 맞추지 못했다: ${checked.errors[0]}`, { details: checked.errors.slice(0, 20), text: answer.text.slice(0, 20_000) }));
      }
      data = checked.value;
    }
    deps.store.finish(jobId, {
      ...(data !== undefined ? { data } : {}),
      text: answer.text,
      ...(parsed.schemaName ? { schemaName: parsed.schemaName } : {}),
      model: answer.model, sessionId: answer.sessionId, costUsd: cost, durationMs: answer.durationMs,
    }, now());
  }

  /** Runs queued jobs one after another; a job that throws fails alone. */
  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try { await runJob(job); }
        catch (error) {
          console.error('[ai-analyze] job failed:', error instanceof Error ? error.message : error);
          try { deps.store.fail(job.jobId, failure(502, 'upstream_error', '분석 중 엔진 내부 오류가 났다. 같은 requestId 로 다시 보내라'), now()); } catch { /* the row stays running and reads as interrupted */ }
        } finally { live.delete(job.jobId); }
      }
    } finally { running = false; }
  }

  return {
    /** `POST /ai/v1/analyze`. */
    submit(raw: unknown): AiAnalyzeReply {
      const parsed = parseRequest(raw);
      if ('code' in parsed) return errorReply(parsed);
      deps.store.purge(now() - KEEP_MS);
      const fingerprint = requestFingerprint(raw as Body);
      const prior = deps.store.byRequestId(parsed.requestId);
      if (prior && prior.status !== 'error' && (prior.status === 'done' || live.has(prior.jobId))) {
        if (prior.fingerprint !== fingerprint) {
          return errorReply(failure(409, 'conflict', `requestId ${parsed.requestId} 는 이미 다른 본문으로 썼다. 본문이 다르면 새 requestId 를 써라`));
        }
        // the stored answer, free this time; a job still going is the same job (no second one is started)
        if (prior.status === 'done') return { status: 200, body: { ok: true, ...prior.result, costUsd: 0, durationMs: 0, cached: true } };
        return { status: 202, body: { ok: true, jobId: prior.jobId, pollAfterMs: POLL_AFTER_MS } };
      }
      const input = decodeInput(parsed.inputs);
      if (input && 'code' in input) return errorReply(input);
      if (queue.length >= maxQueued) {
        return errorReply(failure(429, 'rate_limited', '이 NadoVibe 계정에서 분석이 이미 여러 건 진행·대기 중이다. 잠시 후 같은 requestId 로 다시 보내라', { retryAfterSec: 60 }));
      }
      // a failure, an interrupted job or an expired answer of the same requestId is tried again (§3.1)
      if (prior) deps.store.remove(parsed.requestId);
      const jobId = `job_${randomBytes(8).toString('hex')}`;
      deps.store.insertRunning({ requestId: parsed.requestId, jobId, fingerprint, createdAt: now() });
      live.add(jobId);
      // only what the job needs is kept: the parsed text and the decoded file, not the request body
      queue.push({ parsed: { ...parsed, inputs: [] }, input, jobId });
      void drain();
      return { status: 202, body: { ok: true, jobId, pollAfterMs: POLL_AFTER_MS } };
    },

    /** `GET /ai/v1/analyze/{jobId}`. */
    poll(jobId: string): AiAnalyzeReply {
      const row = JOB_ID.test(jobId) ? deps.store.byJobId(jobId) : null;
      if (!row) return errorReply(failure(404, 'not_found', '그런 작업이 없다 (jobId 가 틀렸거나 보관 기간 48시간이 지났다). 같은 requestId 로 다시 보내라'));
      if (row.status === 'done') return { status: 200, body: { ok: true, status: 'done', ...row.result } };
      if (row.status === 'error' && row.failure) return errorReply(row.failure, true);
      if (live.has(jobId)) return { status: 200, body: { ok: true, status: 'running' } };
      // running in the store but not in this process: the runtime restarted (a release) while it ran
      const cut = failure(502, 'upstream_error', '분석 중에 NadoVibe 런타임이 다시 시작되어 작업이 끊겼다. 같은 requestId 로 다시 보내라', { retryAfterSec: 10 });
      deps.store.fail(jobId, cut, now());
      return errorReply(cut, true);
    },
  };
}
