import webpush from 'web-push';

import type { openStore } from './store.js';

/**
 * Web push for the mobile PWA (IMPLEMENTATION-PLAN C-06). VAPID keys are generated once and kept in
 * the gateway DB; subscriptions are per account. Also runs the Claude subscription-login reminders:
 * the runtime reports its token's expiry (and refused turns) to the gateway, which notifies at
 * 30 / 7 / 1 days before expiry and on expiry — without waking any runtime.
 */
type Store = ReturnType<typeof openStore>;
export type PushPayload = { title: string; body: string; url: string; tag?: string };

const DAY = 86_400_000;
const REMINDER_DAYS = [30, 7, 1, 0];
const LOGIN_URL = '/m/settings?login=claude';

export function createPush(store: Store, subject: string) {
  let keys = (() => { try { return JSON.parse(store.kvGet('vapid') ?? 'null') as { publicKey: string; privateKey: string } | null; } catch { return null; } })();
  if (!keys) { keys = webpush.generateVAPIDKeys(); store.kvSet('vapid', JSON.stringify(keys)); }
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  const publicKey = keys.publicKey;

  /** Sends to every subscription of the account; gone endpoints (404/410) are dropped. */
  async function sendToUser(userId: number, payload: PushPayload) {
    const subs = store.pushSubscriptions(userId);
    let delivered = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: 'normal', topic: payload.tag });
        store.markPush(sub.id, true); delivered++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) store.dropPushSubscription(sub.id);
        else { store.markPush(sub.id, false); console.warn(`[push] user ${userId} send failed (${status ?? 'network'}):`, (error as Error).message); }
      }
    }));
    return { subscriptions: subs.length, delivered };
  }

  /** One reminder per threshold per token; a refused turn is reported once per failure. */
  async function claudeReminders(now = Date.now()) {
    for (const account of store.claudeAuthAccounts()) {
      let notice: string | null = null; let payload: PushPayload | null = null;
      if (account.failureAt) {
        notice = `fail:${account.failureAt}`;
        payload = { title: 'Claude 로그인이 만료되었습니다', body: '다시 로그인해야 Claude 엔진으로 실행됩니다. 눌러서 로그인하세요.', url: LOGIN_URL, tag: 'claude-login' };
      } else if (account.expiresAt) {
        const daysLeft = Math.ceil((account.expiresAt - now) / DAY);
        const due = REMINDER_DAYS.filter((d) => daysLeft <= d).pop();   // the tightest threshold already reached
        if (due !== undefined) {
          notice = `${account.expiresAt}:${due}`;
          payload = due === 0
            ? { title: 'Claude 로그인이 만료되었습니다', body: '눌러서 다시 로그인하세요 (1분).', url: LOGIN_URL, tag: 'claude-login' }
            : { title: `Claude 로그인 만료 D-${Math.max(daysLeft, 1)}`, body: `${new Date(account.expiresAt).toLocaleDateString('ko-KR')}에 만료됩니다. 눌러서 미리 갱신하세요 (1분).`, url: LOGIN_URL, tag: 'claude-login' };
        }
      }
      if (!notice || !payload || notice === account.notice) continue;
      const result = await sendToUser(account.id, payload);
      // recorded even with no subscription yet: the in-app notice covers that case, and a later
      // subscription must not replay stale reminders
      store.setClaudeNotice(account.id, notice);
      console.log(`[push] ${account.username}: ${payload.title} (${result.delivered}/${result.subscriptions})`);
    }
  }

  /** Checks every 6 h (first run a minute after start). */
  function startReminders() {
    const run = () => { void claudeReminders().catch((error) => console.warn('[push] reminders failed:', error instanceof Error ? error.message : error)); };
    setTimeout(run, 60_000).unref();
    setInterval(run, 6 * 3600_000).unref();
  }

  return { publicKey, sendToUser, claudeReminders, startReminders };
}
export type Push = ReturnType<typeof createPush>;
