/**
 * OPS-02 (2026-10-04): the platform ships itself, on the AI-PC. An administrator — or the agent in an administrator's
 * runtime, through /internal/aidev — asks for a ship; runtime-manager (the only service with Docker) runs
 * deploy/aidev/release/ship.sh in a short-lived container: fetch, checks, pack, deploy, verify (rollback on failure),
 * push to GitHub main. No approval step (user decision 2026-10-04: tests and checks gate it). The gateway relays the
 * request, the status and the log, and tells the requester by push when the ship has a result.
 */
import type { Push } from './push.js';

export type ShipResult = { status: 'ok' | 'failed' | 'rolled_back' | 'push_failed' | string; sha: string; text: string };
export type ShipStatus = {
  id: string; requester: string | null; running: boolean; exitCode: number | null; startedAt: string | null; finishedAt: string | null;
  step: string | null; result: ShipResult | null; log: string;
};
type ShipDeps = { managerUrl: string; managerToken: string; push: Push; userIdByName: (username: string) => number | null; pollMs?: number };

export class ShipError extends Error { constructor(public status: number, message: string) { super(message); } }

const RESULT_TEXT: Record<string, string> = { ok: '배포 완료', failed: '배포 안 함 (검사 실패)', rolled_back: '배포 후 문제로 되돌림', push_failed: '배포됨 · GitHub 반영 실패' };

export function createPlatformShip(deps: ShipDeps) {
  const notified = new Set<string>();
  async function manager<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${deps.managerUrl}${path}`, {
      ...init, headers: { 'x-runtime-token': deps.managerToken, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new ShipError(response.status === 409 || response.status === 400 || response.status === 404 ? response.status : 502, body.error ?? `runtime-manager ${response.status}`);
    return body;
  }
  const start = (input: { runtime: string; requester: string; from?: string; ref?: string }) =>
    manager<ShipStatus>('/v1/ship', { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), ...input }) });
  const status = (id: string) => manager<ShipStatus>(`/v1/ship/${encodeURIComponent(id)}`);
  const list = () => manager<{ ships: Array<{ id: string; requester: string | null; running: boolean; created: number }> }>('/v1/ship');

  /** Pushes the result to the requester once (the ship may keep draining runtimes after it). */
  async function notifyFinished() {
    const { ships } = await list();
    for (const ship of ships.slice(0, 5)) {
      if (notified.has(ship.id) || Date.now() - ship.created > 6 * 3600_000) continue;
      const s = await status(ship.id).catch(() => null);
      if (!s?.result) continue;
      notified.add(ship.id);
      const userId = s.requester ? deps.userIdByName(s.requester) : null;
      if (userId === null) continue;
      const sha = s.result.sha === 'none' ? '' : ` ${s.result.sha.slice(0, 7)}`;
      await deps.push.sendToUser(userId, { title: `NadoVibe ${RESULT_TEXT[s.result.status] ?? s.result.status}${sha}`, body: s.result.text.slice(0, 180), url: '/m/settings', tag: `ship-${ship.id}` }).catch(() => undefined);
    }
  }
  function startWatcher() {
    // ships already finished when the gateway starts are not announced again
    void list().then(({ ships }) => { for (const s of ships) if (!s.running) notified.add(s.id); }).catch(() => undefined)
      .finally(() => setInterval(() => { void notifyFinished().catch(() => undefined); }, deps.pollMs ?? 15_000).unref());
  }
  return { start, status, list, notifyFinished, startWatcher };
}
export type PlatformShip = ReturnType<typeof createPlatformShip>;
