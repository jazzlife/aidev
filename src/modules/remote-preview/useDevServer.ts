import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { RemoteDevProject, RemoteDevScan } from '@/shared/types';

/** Where starting a dev server stands: running the command, waiting for its port, ready, or failed. */
type StartState =
  | { phase: 'idle' }
  | { phase: 'starting'; remoteRunId: number | null; port: number; since: number }
  | { phase: 'ready'; port: number }
  | { phase: 'failed'; message: string; remoteRunId: number | null };

const WAIT_MS = 120_000;
const POLL_MS = 2_000;

/** A project's command with the preview's port and path filled in. */
export function fillCommand(template: string, port: number, base: string) {
  return template.split('{port}').join(String(port)).split('{base}').join(base);
}

/**
 * The preview window's dev-server helper (F-06b, workbench PreviewPane and mobile preview screen): what listens on the PC and which projects can be started
 * (runner `dev.scan`), and `start()` — runs a project's dev command through the runner (a pty run the user
 * can watch in "원격 실행"), then waits until a server answers on the port: the preview port itself, or a
 * port that opened after the start (frameworks that pick their own). `onReady(port)` opens the preview.
 */
export function useDevServer(targetId: number | null, port: number, active: boolean, onReady: (port: number) => void) {
  const [scan, setScan] = useState<RemoteDevScan | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [start, setStart] = useState<StartState>({ phase: 'idle' });
  const cancelled = useRef(false);
  const readyRef = useRef(onReady);
  const portRef = useRef(port);
  useEffect(() => { readyRef.current = onReady; portRef.current = port; });

  // the scan follows the target, not each keystroke in the port box (the port only picks the preview path)
  const load = useCallback(async (p: number = portRef.current) => {
    if (!targetId) return null;
    try {
      const s = await readApiJson<RemoteDevScan>(await api.targets.dev(targetId, p));
      setScan(s); setScanError(null);
      return s;
    } catch (error) { setScanError(error instanceof Error ? error.message : '포트·프로젝트를 읽지 못했습니다'); return null; }
  }, [targetId]);

  useEffect(() => { setScan(null); if (active && targetId) void load(); }, [active, targetId, load]);
  useEffect(() => () => { cancelled.current = true; }, []);

  /** `command`: as the user edited it, or null for the project's own command (filled with a fresh path). */
  const run = useCallback(async (project: RemoteDevProject, edited: string | null, wantPort: number) => {
    if (!targetId) return;
    cancelled.current = false;
    const fresh = await load(wantPort);
    if (!fresh) { setStart({ phase: 'failed', message: '원격 PC의 상태를 읽지 못했습니다', remoteRunId: null }); return; }
    const before = new Set(fresh.ports.map((p) => p.port));
    const command = edited ?? fillCommand(project.command, wantPort, fresh.base);
    const env = Object.fromEntries(Object.entries(project.env).map(([k, v]) => [k, fillCommand(v, wantPort, fresh.base)]));
    let remoteRunId: number | null = null;
    try {
      const r = await readApiJson<{ stream?: { remoteRunId: number } }>(await api.targets.exec(targetId, { cmd: command, cwd: project.dir, pty: true, cols: 120, rows: 30, ...(Object.keys(env).length ? { env } : {}) }));
      remoteRunId = r.stream?.remoteRunId ?? null;
    } catch (error) { setStart({ phase: 'failed', message: error instanceof Error ? error.message : '명령을 시작하지 못했습니다', remoteRunId: null }); return; }
    const since = Date.now();
    setStart({ phase: 'starting', remoteRunId, port: wantPort, since });
    while (!cancelled.current && Date.now() - since < WAIT_MS) {
      await new Promise((resolve) => { window.setTimeout(resolve, POLL_MS); });
      // the run ended (install missing, port taken, …): say so instead of waiting out the timeout
      if (remoteRunId) {
        try {
          const rr = await readApiJson<{ run: { finished_at: number | null; exit_code: number | null; live: { running: boolean } | null } }>(await api.targets.remoteRun(remoteRunId));
          if (rr.run.finished_at || rr.run.live?.running === false) {
            setStart({ phase: 'failed', message: `개발 서버가 종료됐습니다 (exit ${rr.run.exit_code ?? '?'}) — 출력에서 원인을 확인하세요`, remoteRunId });
            return;
          }
        } catch { /* keep waiting */ }
      }
      const now = await load(wantPort);
      if (!now) continue;
      const open = now.ports.filter((p) => p.loopback);
      const hit = open.find((p) => p.port === wantPort) ?? open.find((p) => !before.has(p.port));
      if (hit) { setStart({ phase: 'ready', port: hit.port }); readyRef.current(hit.port); return; }
    }
    if (!cancelled.current) setStart({ phase: 'failed', message: `${WAIT_MS / 1000}초 동안 포트가 열리지 않았습니다 — 출력에서 서버 주소를 확인하세요`, remoteRunId });
  }, [targetId, load]);

  const reset = useCallback(() => { cancelled.current = true; setStart({ phase: 'idle' }); }, []);
  return { scan, scanError, reload: load, start, run, reset };
}
