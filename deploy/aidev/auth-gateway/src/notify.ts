import { decide } from './laya-questions.js';
import type { LayaClient } from './laya.js';
import type { Push } from './push.js';
import type { openStore } from './store.js';

/**
 * C-06 `notify.level` (IMPLEMENTATION-PLAN §3.10/§3.11): what a user's runtime reports (a run finished, failed,
 * needs approval …) and how loudly the phone hears about it — Laya decides 0 quiet / 1 badge / 2 push
 * (fallback 1). A run blocked on approval always pushes; while one of the user's apps is open the news is
 * already on screen, so it stays a badge. Badges are kept per session until that session is opened.
 */
type Store = ReturnType<typeof openStore>;
export type NotifyEvent = { code: string; sessionId: string | null; sessionName: string | null; provider: string | null; detail: string | null };

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** The Korean line shown on the phone for a runtime event code. */
export function describeEvent(e: NotifyEvent) {
  const who = PROVIDER_LABEL[e.provider ?? ''] ?? 'Agent';
  switch (e.code) {
    case 'run.stopped': return e.detail && e.detail !== 'completed' ? `${who}: 실행이 멈췄습니다 (${e.detail})` : `${who}: 작업이 끝났습니다`;
    case 'run.failed': return `${who}: 실행 실패${e.detail ? ` — ${e.detail}` : ''}`;
    case 'run.background_completed': return `${who}: 백그라운드 작업이 끝났습니다`;
    case 'permission.required': return `${who}: 승인이 필요합니다${e.detail ? ` (${e.detail})` : ''}`;
    case 'agent.notification': return `${who}: ${e.detail ?? '새 알림'}`;
    default: return `${who}: ${e.detail ?? e.code}`;
  }
}

export function createNotifier(deps: { store: Store; laya: LayaClient; push: Push; isOnline: (userId: number) => boolean }) {
  return {
    async handle(userId: number, event: NotifyEvent) {
      const body = describeEvent(event);
      const online = deps.isOnline(userId);
      const judged = await decide(deps.laya, 'notify.level', { state: { event: event.code, message: body, session: event.sessionName, app_open: online } });
      deps.store.logKindDecision({ userId, kind: judged.kind, command: body, answer: judged.answer, confidence: judged.confidence, probabilities: judged.probabilities, latencyMs: judged.latency_ms, device: judged.device, fallback: judged.fallback });
      let level = Math.max(0, Math.min(2, Math.round(Number(judged.answer) || 0)));
      if (event.code === 'permission.required') level = 2;   // the run waits until someone answers
      if (online) level = Math.min(level, 1);                 // an open app already shows it
      const title = event.sessionName || 'Nado AI Dev';
      if (level >= 1 && event.sessionId) deps.store.markUnread(userId, { sessionId: event.sessionId, level, code: event.code, title, body });
      let pushed = 0;
      if (level >= 2) {
        const url = event.sessionId ? `/m/session/${encodeURIComponent(event.sessionId)}` : '/m/';
        pushed = (await deps.push.sendToUser(userId, { title, body, url, tag: `session-${event.sessionId ?? 'none'}` }).catch(() => ({ delivered: 0 }))).delivered ?? 0;
      }
      console.log(`[notify] user ${userId} ${event.code} → level ${level}${judged.fallback ? ' (fallback)' : ''}${online ? ' app open' : ''}${pushed ? ` pushed ${pushed}` : ''}`);
      return { level, online, pushed, fallback: judged.fallback };
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
