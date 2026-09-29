/**
 * Laya client (System-1 decision model, aidev-laya service). The gateway is the only caller.
 * Circuit breaker: after a failed call every kind falls back immediately for RETRY_MS, then one
 * probe is allowed (plan §3.10 rule d). Timeouts are short — decisions gate the chat send path.
 */
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] };
export type NoulQuestion = { type: 'noul'; instructions: string };
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Answer = { choice?: string; probabilities?: Record<string, number>; confidence?: number; score?: number; noul?: number };
export type PredictResult = { answers: Record<string, Answer>; latency_ms: number; usage?: unknown; device?: string };

const RETRY_MS = Number(process.env.LAYA_RETRY_MS ?? 30_000);

export class LayaClient {
  private downUntil = 0;
  private lastError: string | null = null;
  constructor(private baseUrl: string, private timeoutMs = 8000) {}

  get available() { return Date.now() >= this.downUntil; }
  get status() { return { available: this.available, lastError: this.lastError, retryAt: this.downUntil || null }; }

  private trip(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.downUntil = Date.now() + RETRY_MS;
  }

  async health(): Promise<Record<string, unknown> & { status: string }> {
    const r = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return await r.json() as Record<string, unknown> & { status: string };
  }

  /** Raw predict. Throws when Laya is unreachable/unloaded; the caller decides the fallback. */
  async predict(state: Record<string, unknown>, questions: Record<string, Question>): Promise<PredictResult> {
    if (!this.available) throw new Error(`Laya circuit open (${this.lastError ?? 'recent failure'})`);
    try {
      const r = await fetch(`${this.baseUrl}/decide`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, questions }), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) throw new Error(`Laya ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const out = await r.json() as PredictResult;
      if (!out || typeof out !== 'object' || !out.answers) throw new Error('Laya returned no answers');
      this.lastError = null;
      return out;
    } catch (error) { this.trip(error); throw error; }
  }

  /** Embedding shortlist for large option sets (>20). Falls back to the first k options on failure. */
  async shortlist(state: Record<string, unknown>, options: Record<string, string>, k: number, instructions: string): Promise<string[]> {
    const keys = Object.keys(options);
    if (keys.length <= k) return keys;
    if (!this.available) return keys.slice(0, k);
    try {
      const r = await fetch(`${this.baseUrl}/shortlist`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, options, k, instructions }), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) throw new Error(`Laya shortlist ${r.status}`);
      const out = await r.json() as { keep?: string[] };
      return Array.isArray(out.keep) && out.keep.length ? out.keep.filter((key) => key in options) : keys.slice(0, k);
    } catch (error) { this.trip(error); return keys.slice(0, k); }
  }
}

/** Truncate a state object to a token budget (≈4 chars/token); `command` is kept in full first. */
export function budgetState(state: Record<string, unknown>, tokens = 1024) {
  let remaining = tokens * 4;
  const out: Record<string, unknown> = {};
  const order = ['command', ...Object.keys(state).filter((key) => key !== 'command')];
  for (const key of order) {
    const value = state[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (remaining <= 0) break;
    out[key] = text.length > remaining ? `${text.slice(0, remaining)}…` : (typeof value === 'string' ? value : value);
    remaining -= Math.min(text.length, remaining);
  }
  return out;
}

export function topChoice(answer: Answer | undefined) {
  const probs = answer?.probabilities ?? {};
  const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  return { choice: answer?.choice ?? top?.[0] ?? null, probability: top?.[1] ?? 0, ranked, confidence: answer?.confidence ?? top?.[1] ?? 0 };
}
