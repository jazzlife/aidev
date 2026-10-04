import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { callGateway } from '@/modules/aidev-tools/aidev-tools.service.js';

/**
 * platform_ship / platform_ship_status (OPS-02, 2026-10-04): an administrator's agent ships NadoVibe itself from this
 * runtime. The commit at HEAD of a clone of the platform repository in /workspace goes to the gateway, which has
 * runtime-manager build, test, deploy and verify it on the AI-PC and push it to GitHub main (ship.sh). Only committed
 * work ships, and only what continues GitHub main.
 */
const run = promisify(execFile);
const WORKSPACE = process.env.AIDEV_WORKSPACE_ROOT || '/workspace';
const STATUS_POLL_MS = 5000;
const MAX_WAIT_SEC = 600;

type ShipStatus = { id: string; running: boolean; step: string | null; result: { status: string; sha: string; text: string } | null; log: string };

const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args], { timeout: 20_000 })).stdout.trim();

/** The repository the agent works in, as a path under /workspace (what runtime-manager mounts read-only). */
async function workspaceRepo(dir: string) {
  const top = await git(dir, 'rev-parse', '--show-toplevel').catch(() => { throw new Error(`${dir} is not inside a git repository`); });
  // both sides resolved: git reports the real path, the workspace root may be reached through a link
  const root = fs.existsSync(WORKSPACE) ? fs.realpathSync(WORKSPACE) : WORKSPACE;
  const relative = path.relative(root, fs.realpathSync(top));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`the repository must be under ${WORKSPACE} (found ${top})`);
  return { top, relative };
}

/** Used by the MCP bridge route: starts a ship of HEAD (or `ref`) of the repository at `dir`, or of GitHub main. */
export async function platformShip(input: { dir?: string | null; ref?: string; fromGithub?: boolean }) {
  if (input.fromGithub) return await callGateway('POST', '/platform/ship', { ref: input.ref || 'main' }) as ShipStatus;
  if (!input.dir) throw new Error('path is required (the platform repository in /workspace)');
  const { top, relative } = await workspaceRepo(input.dir);
  const dirty = await git(top, 'status', '--porcelain', '--untracked-files=no');
  if (dirty) throw new Error(`uncommitted changes in ${top} — commit them first (only commits ship):\n${dirty.split('\n').slice(0, 10).join('\n')}`);
  const sha = await git(top, 'rev-parse', input.ref || 'HEAD');
  const status = await callGateway('POST', '/platform/ship', { from: relative, ref: sha }) as ShipStatus;
  return { ...status, shipping: sha, repository: top };
}

/** Used by the MCP bridge route: a ship's step, result and log tail; with waitSec, waits for the result. */
export async function platformShipStatus(input: { id: string; waitSec?: number }) {
  if (!/^[a-z0-9]{8,32}$/.test(input.id)) throw new Error('id: the ship id platform_ship returned');
  const deadline = Date.now() + Math.min(Math.max(input.waitSec ?? 0, 0), MAX_WAIT_SEC) * 1000;
  for (;;) {
    const status = await callGateway('GET', `/platform/ship/${input.id}`) as ShipStatus;
    if (status.result || Date.now() >= deadline) return { ...status, log: status.log.split('\n').slice(-60).join('\n') };
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
}
