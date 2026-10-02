/**
 * App control (2026-10-02, "agent가 nadovibe 안의 기능을 제어하여 사용자에게 원격 화면을 보여주거나 설정을 도와주는"):
 * an agent asks the user's open NadoVibe pages to show something — a PC's live screen (a window or the whole screen),
 * a preview, the debugger, PC pairing, settings, a project, an agent — or to apply a setting that lives in the page
 * (the routing mode). Commands queue per user in memory for a minute; every visible workbench or phone page long-polls
 * them (GET /ui/commands?after=) and carries them out. `viewers` tells the agent whether anyone was watching.
 */
export const UI_VIEWS = ['screen', 'preview', 'debug', 'pcs', 'settings', 'project', 'catalog', 'chat'] as const;
export type UiView = typeof UI_VIEWS[number];
export const UI_SETTINGS = ['routing_mode'] as const;

export type UiCommand = {
  id: number; at: number; by: string | null;
  action: 'show' | 'set';
  view?: UiView;
  /** show: target, window ('full' or an id), port, session, section, projectId, agent; set: key, value */
  params: Record<string, string | number | boolean | null>;
  /** a line for the user ("agent가 m4pro 화면을 엽니다") */
  note: string | null;
};

const KEEP_MS = 60_000;
const VIEWER_MS = 35_000;

export function createUiControl() {
  let nextId = 1;
  const queues = new Map<number, UiCommand[]>();
  const waiters = new Map<number, Set<() => void>>();
  /** userId → clientId → last poll */
  const viewers = new Map<number, Map<string, number>>();

  const prune = (uid: number) => {
    const q = (queues.get(uid) ?? []).filter((c) => Date.now() - c.at < KEEP_MS);
    queues.set(uid, q);
    return q;
  };
  const watching = (uid: number) => {
    const v = viewers.get(uid);
    if (!v) return 0;
    for (const [client, at] of v) if (Date.now() - at > VIEWER_MS) v.delete(client);
    return v.size;
  };

  return {
    /** Queues a command for the user's pages; returns it and how many pages are watching. */
    push(uid: number, cmd: Omit<UiCommand, 'id' | 'at'>) {
      const full: UiCommand = { ...cmd, id: nextId++, at: Date.now() };
      prune(uid).push(full);
      for (const wake of waiters.get(uid) ?? []) wake();
      waiters.delete(uid);
      return { command: full, viewers: watching(uid) };
    },
    /** Commands after `after` for a page; waits up to `timeoutMs` when there are none. `after` 0 = only new ones. */
    async poll(uid: number, client: string, after: number, timeoutMs: number) {
      const seen = viewers.get(uid) ?? new Map<string, number>();
      seen.set(client, Date.now());
      viewers.set(uid, seen);
      // a page that just opened (after 0) starts from now: it must not replay what was shown before it existed; it
      // continues from the `last` it is given back
      const since = after > 0 ? after : nextId - 1;
      let fresh = prune(uid).filter((c) => c.id > since);
      if (!fresh.length && timeoutMs > 0) {
        await new Promise<void>((resolve) => {
          const set = waiters.get(uid) ?? new Set<() => void>();
          const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
          const timer = setTimeout(done, timeoutMs);
          set.add(done);
          waiters.set(uid, set);
        });
        seen.set(client, Date.now());
        fresh = prune(uid).filter((c) => c.id > since);
      }
      return { commands: fresh, last: Math.max(since, ...fresh.map((c) => c.id)) };
    },
    viewers: watching,
  };
}

export type UiControl = ReturnType<typeof createUiControl>;

/** Validates an agent's (or a page's) command; throws a message for a bad one. */
export function parseUiCommand(b: Record<string, unknown>): Omit<UiCommand, 'id' | 'at' | 'by'> {
  const action = b.action === 'set' ? 'set' : b.action === 'show' ? 'show' : null;
  if (!action) throw new Error('action: show | set');
  const raw = b.params && typeof b.params === 'object' ? b.params as Record<string, unknown> : {};
  const params: UiCommand['params'] = {};
  for (const [k, v] of Object.entries(raw).slice(0, 12)) {
    if (!/^[a-zA-Z_]{1,24}$/.test(k)) continue;
    if (typeof v === 'string') params[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
    else if (typeof v === 'boolean' || v === null) params[k] = v;
  }
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 200) : null;
  if (action === 'show') {
    const view = UI_VIEWS.find((x) => x === b.view);
    if (!view) throw new Error(`view: ${UI_VIEWS.join(' | ')}`);
    return { action, view, params, note };
  }
  if (!UI_SETTINGS.some((k) => k === params.key)) throw new Error(`set key: ${UI_SETTINGS.join(' | ')}`);
  return { action, params, note };
}
