import { useCallback, useEffect, useMemo, useState } from 'react';

import { aidevApi, type Engine } from '@/modules/aidev-router/api';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * Where a handoff session came from (2026-10-09). A usage limit moves the work to a new session on the
 * other engine; CloudCLI sessions are engine-bound, so that session can never run Claude again — and the
 * limit resetting changed nothing visible ("한도가 풀렸는데 Claude가 안 보여"). The origin is remembered
 * per handoff session so the chat can offer the way back once the engine it left is usable again.
 */
export type HandoffOrigin = { fromSessionId: string; fromEngine: Engine; toEngine: Engine; reason: string | null; at: number };

const KEY = 'aidev.handoffOrigins';
const ENGINE_LABEL: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };
/** How often the handoff session asks whether the engine it left is back (the gateway's auth cache is 60 s). */
const POLL_MS = 60_000;

function readAll(): Record<string, HandoffOrigin> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, HandoffOrigin>; } catch { return {}; }
}

/** Used by useEscalation when it opens a handoff session: remembers where that session came from. */
export function rememberHandoff(newSessionId: string, origin: HandoffOrigin) {
  try {
    const all = readAll();
    all[newSessionId] = origin;
    // the record is only needed while the handoff is recent: keep the newest 20
    const trimmed = Object.fromEntries(Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, 20));
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch { /* per-device convenience only */ }
}

/** Used by tests and the hook: the origin of a handoff session, or null. */
export function handoffOrigin(sessionId: string | null | undefined): HandoffOrigin | null {
  return sessionId ? readAll()[sessionId] ?? null : null;
}

function forget(sessionId: string) {
  try { const all = readAll(); delete all[sessionId]; localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

/**
 * Used by the hook and tests: the origin a chat may be offered to return to, or null. A chat that is itself
 * the way back — Claude → (limit) Codex → (limit) Claude — has nothing to return to: the Codex hop came from
 * the engine this chat already runs on, so offering "Codex로 돌아가기" there only nags (2026-10-09).
 */
export function returnTarget(sessionId: string | null | undefined): HandoffOrigin | null {
  const origin = handoffOrigin(sessionId);
  if (!origin) return null;
  const upstream = handoffOrigin(origin.fromSessionId);
  if (upstream && upstream.fromEngine === origin.toEngine) return null;
  return origin;
}

export type ReturnFromHandoff = {
  /** the engine the chat left, once it is usable again (null: nothing to offer) */
  engine: Engine | null;
  label: string | null;
  /** when the engine is still inside its usage-limit window: its reset time */
  limitedUntil: number | null;
  busy: boolean;
  error: string | null;
  /** builds a brief of this chat and queues it for the original session, then opens it */
  returnNow: () => Promise<void>;
  dismiss: () => void;
};

/**
 * Used by ChatInterface (workbench) and the mobile ChatScreen: for a chat that was handed off from another
 * engine, polls the engines while open and offers "Claude로 돌아가기" once that engine is usable again. The
 * return reuses the handoff mechanics in reverse: a brief of this chat is queued for the original session
 * (which keeps its own context) and the host opens it; its take-handoff effect sends the brief.
 */
export function useReturnFromHandoff(sessionId: string | null, openSession: (sessionId: string, engine: Engine, title: string) => void): ReturnFromHandoff {
  // read once per session: the record is written when the handoff opens, before this chat is shown
  const origin = useMemo(() => returnTarget(sessionId), [sessionId]);
  // what the last poll said about the engine this chat left
  const [state, setState] = useState<{ usable: boolean; limitedUntil: number | null }>({ usable: false, limitedUntil: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // closing the card is final for this chat: the origin record is dropped, so it does not come back on reopen
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!origin || !sessionId) return undefined;
    let alive = true;
    const poll = () => {
      aidevApi.engines(true).then((result) => {
        if (!alive) return;
        const info = result.engines[origin.fromEngine];
        const limitedUntil = info?.limited_until && info.limited_until > Date.now() ? info.limited_until : null;
        setState({ usable: Boolean(info?.allowed && info.authenticated) && !limitedUntil, limitedUntil });
      }).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [origin, sessionId]);

  const returnNow = useCallback(async () => {
    if (!origin || !sessionId || busy) return;
    setBusy(true); setError(null);
    try {
      const brief = await aidevApi.handoffBrief(sessionId, { from_engine: origin.toEngine, to_engine: origin.fromEngine, reason: `${ENGINE_LABEL[origin.fromEngine]} 사용량 한도가 풀려 돌아왔습니다` });
      const agentName = routingStore.get().last?.agent.name ?? null;
      routingStore.patch({ pendingHandoff: { sessionId: origin.fromSessionId, text: brief.text }, oneShotPlan: { engine: origin.fromEngine }, oneShotAgent: agentName && agentName !== 'agent-architect' ? agentName : null, escalation: null });
      forget(sessionId);
      openSession(origin.fromSessionId, origin.fromEngine, `[${ENGINE_LABEL[origin.fromEngine]} 복귀]`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '돌아가지 못했습니다');
    } finally {
      setBusy(false);
    }
  }, [busy, openSession, origin, sessionId]);

  const offer = Boolean(origin && sessionId && dismissed !== sessionId && state.usable);
  // "한도가 풀렸습니다" only for a handoff the limit caused; another reason just offers the way back
  const wasLimit = Boolean(origin?.reason && /usage_limit|한도/.test(origin.reason));
  return {
    engine: offer && origin ? origin.fromEngine : null,
    label: offer && origin ? `${ENGINE_LABEL[origin.fromEngine]}${wasLimit ? ' 한도가 풀렸습니다' : '를 다시 쓸 수 있습니다'} — ${ENGINE_LABEL[origin.fromEngine]}로 돌아가기` : null,
    limitedUntil: origin && dismissed !== sessionId ? state.limitedUntil : null,
    busy, error, returnNow,
    dismiss: () => { setDismissed(sessionId); if (sessionId) forget(sessionId); },
  };
}
