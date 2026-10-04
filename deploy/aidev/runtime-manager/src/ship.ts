/**
 * OPS-02: the pure parts of runtime-manager's ship endpoints (request checks, reading a ship's log), kept apart from
 * runtime-manager.ts so they can be tested without its secrets and Docker socket.
 */
/** Runtime container names runtime-manager manages (user01…, u<24 hex>). */
export const validRuntimeName = (name: string) => /^(user\d{2}|u[a-f0-9]{24})$/.test(name);

export type ShipRequest = { id: string; runtime: string; requester: string; from?: string; ref?: string };
/** The ship request as the gateway sends it, checked: ids, the runtime, a workspace path and a git ref that cannot
 * escape (no `..`, no option-like ref). */
export function checkShipRequest(body: Partial<ShipRequest>): ShipRequest {
  const id = String(body.id ?? ''); const runtime = String(body.runtime ?? ''); const requester = String(body.requester ?? '');
  if (!/^[a-z0-9]{8,32}$/.test(id)) throw new Error('bad ship id');
  if (!validRuntimeName(runtime)) throw new Error('bad runtime');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(requester)) throw new Error('bad requester');
  const from = body.from ? String(body.from).replace(/^\/workspace\//, '').replace(/\/+$/, '') : undefined;
  if (from !== undefined && (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(from) || from.split('/').some((part) => part === '..' || part === '.'))) throw new Error('bad workspace path');
  const ref = body.ref ? String(body.ref) : undefined;
  if (ref !== undefined && (!/^[A-Za-z0-9_./-]{1,100}$/.test(ref) || ref.startsWith('-') || ref.includes('..'))) throw new Error('bad ref');
  return { id, runtime, requester, from, ref };
}
/** A ship's progress from its log: the last SHIP_STEP, and SHIP_RESULT once it has one (draining may still run). */
export function readShipLog(log: string) {
  const lines = log.replace(/\r/g, '').split('\n');
  const step = [...lines].reverse().find((l) => l.startsWith('SHIP_STEP '))?.slice(10).trim() ?? null;
  const last = [...lines].reverse().find((l) => l.startsWith('SHIP_RESULT '));
  const result = last ? (() => { const [, status, sha, ...text] = last.split(' '); return { status, sha, text: text.join(' ') }; })() : null;
  return { step, result };
}
