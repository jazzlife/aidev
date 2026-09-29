import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import ignore from 'ignore';

import { callGateway, resolveTarget } from '@/modules/aidev-tools/aidev-tools.service.js';

/**
 * remote_sync (IMPLEMENTATION-PLAN §3.12, F-04): copy a project from this runtime to one of the user's
 * machines, sending only what changed.
 *   files   = `git ls-files --cached --others --exclude-standard` in a git repo, else a walk honouring
 *             the root .gitignore; always minus .aidevignore and the defaults (node_modules, .git, …)
 *   dest    = <first allowed folder>/<project folder name> unless given
 *   diff    = runner `sync.manifest` (sha256) → `sync.write` in ≤4 MB batches (big files in chunks)
 *             → `sync.delete` of files an earlier sync wrote and the project no longer has
 * Dependencies are not copied: install them on the target (npm ci, pip install -r …).
 */
const run = promisify(execFile);
const DEFAULT_IGNORES = ['node_modules/', '.git/', '.aidev/', '.DS_Store', '__pycache__/', '.venv/', 'venv/', '.pytest_cache/', '.next/', '.nuxt/', '.turbo/', '.cache/', '*.aidev-part'];
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const BATCH_BYTES = 4 * 1024 * 1024;

export type SyncInput = { target?: string | number; project?: string; dest?: string; dryRun?: boolean };
export type SyncTurn = { runId?: number | null; targetId?: number | null; cwd?: string | null };
type LocalFile = { path: string; abs: string; size: number; mode: number; sha256: string };
type RemoteFile = { path: string; size: number; sha256: string; synced: boolean };

const sha256File = (file: string) => new Promise<string>((resolve, reject) => {
  const h = createHash('sha256');
  fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

/** The project folder: an absolute path or a name under ~/workspace, never the home folder itself. */
export function resolveProjectDir(project: string | undefined, cwd: string | null | undefined): string {
  const home = os.homedir();
  const raw = project?.trim() || cwd || '';
  if (!raw) throw new Error('project 경로가 필요합니다 (현재 세션의 프로젝트 폴더를 알 수 없음)');
  const candidates = path.isAbsolute(raw) ? [raw] : [path.join(home, 'workspace', raw), path.join(home, raw), cwd ? path.resolve(cwd, raw) : ''];
  for (const c of candidates.filter(Boolean)) {
    let real: string;
    try { real = fs.realpathSync(c); } catch { continue; }
    if (!fs.statSync(real).isDirectory()) continue;
    if (real === home || real === '/' || real === path.dirname(home)) throw new Error(`홈 폴더 전체는 동기화할 수 없습니다: ${real}`);
    return real;
  }
  throw new Error(`프로젝트 폴더가 없습니다: ${raw}`);
}

/** Relative paths of the project's files, after .gitignore / .aidevignore / defaults. */
export async function listProjectFiles(dir: string): Promise<string[]> {
  const ig = ignore().add(DEFAULT_IGNORES);
  const aidevIgnore = path.join(dir, '.aidevignore');
  if (fs.existsSync(aidevIgnore)) ig.add(fs.readFileSync(aidevIgnore, 'utf8'));
  let files: string[] | null = null;
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      const { stdout } = await run('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 });
      files = stdout.split('\0').filter(Boolean);
    } catch { files = null; }
  }
  if (!files) {
    const gi = ignore().add(DEFAULT_IGNORES);
    const gitignore = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignore)) gi.add(fs.readFileSync(gitignore, 'utf8'));
    files = [];
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!gi.ignores(`${child}/`)) walk(child); }
        else if (entry.isFile() && !gi.ignores(child)) files!.push(child);
        if (files!.length > MAX_FILES) return;
      }
    };
    walk('');
  }
  return files.filter((f) => !ig.ignores(f)).sort();
}

async function rpc(targetId: number, method: string, params: Record<string, unknown>) {
  const r = await callGateway('POST', `/targets/${targetId}/rpc`, { method, params }, method === 'sync.manifest' ? 200_000 : 150_000) as { result?: unknown };
  return r.result as Record<string, unknown>;
}

export async function remoteSync(input: SyncInput, turn: SyncTurn = {}) {
  const t0 = Date.now();
  const target = await resolveTarget(input.target, turn.targetId ?? null);
  if (!target.online) throw new Error(`대상 ${target.name}이(가) 오프라인입니다 — 러너가 실행 중인지 확인하세요`);
  const dir = resolveProjectDir(input.project, turn.cwd);
  const project = path.basename(dir);
  const roots = target.allowed_roots ?? [];
  if (!roots.length) throw new Error(`대상 ${target.name}에 허용 폴더가 없습니다 (aidev-runner roots add <폴더>)`);
  const dest = input.dest?.trim()
    ? (input.dest.startsWith('/') || input.dest.startsWith('~') || /^[A-Za-z]:/.test(input.dest) ? input.dest.trim() : `${roots[0].replace(/[\\/]+$/, '')}/${input.dest.trim()}`)
    : `${roots[0].replace(/[\\/]+$/, '')}/${project}`;

  // local side
  const names = await listProjectFiles(dir);
  if (names.length > MAX_FILES) throw new Error(`파일이 너무 많습니다 (${names.length} > ${MAX_FILES}) — .aidevignore로 제외하세요`);
  const local: LocalFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const rel of names) {
    const abs = path.join(dir, rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(abs); } catch { continue; }   // listed by git but deleted
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) { skipped.push(`${rel} (${Math.round(st.size / 1048576)}MB)`); continue; }
    total += st.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('프로젝트가 500MB를 넘습니다 — .aidevignore로 큰 파일을 제외하세요');
    local.push({ path: rel, abs, size: st.size, mode: st.mode & 0o777, sha256: await sha256File(abs) });
  }

  // remote side
  const manifest = await rpc(target.id, 'sync.manifest', { root: dest });
  const remoteRoot = String(manifest.root ?? dest);
  const remote = new Map(((manifest.files ?? []) as RemoteFile[]).map((f) => [f.path, f]));
  const changed = local.filter((f) => remote.get(f.path)?.sha256 !== f.sha256);
  const localSet = new Set(local.map((f) => f.path));
  const removed = [...remote.values()].filter((f) => f.synced && !localSet.has(f.path)).map((f) => f.path);
  const bytes = changed.reduce((n, f) => n + f.size, 0);
  const summary = { target: target.name, project, source: dir, dest: remoteRoot, files: local.length, uploaded: changed.length, deleted: removed.length, unchanged: local.length - changed.length, bytes, skipped };
  if (input.dryRun) return { ...summary, dryRun: true, toUpload: changed.slice(0, 50).map((f) => f.path), toDelete: removed.slice(0, 50), ms: Date.now() - t0 };

  let error: string | null = null;
  try {
    // uploads in ≤4 MB batches; a bigger file goes alone in 4 MB chunks
    let batch: Array<Record<string, unknown>> = [];
    let batchBytes = 0;
    const flush = async () => { if (batch.length) await rpc(target.id, 'sync.write', { root: remoteRoot, files: batch }); batch = []; batchBytes = 0; };
    for (const f of changed) {
      if (f.size > BATCH_BYTES) {
        await flush();
        const fd = fs.openSync(f.abs, 'r');
        try {
          for (let offset = 0; offset < f.size; offset += BATCH_BYTES) {
            const len = Math.min(BATCH_BYTES, f.size - offset);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, offset);
            await rpc(target.id, 'sync.write', { root: remoteRoot, files: [{ path: f.path, b64: buf.toString('base64'), offset, last: offset + len >= f.size, mode: f.mode }] });
          }
        } finally { fs.closeSync(fd); }
        continue;
      }
      if (batchBytes + f.size > BATCH_BYTES) await flush();
      batch.push({ path: f.path, b64: fs.readFileSync(f.abs).toString('base64'), mode: f.mode });
      batchBytes += f.size;
    }
    await flush();
    for (let i = 0; i < removed.length; i += 500) await rpc(target.id, 'sync.delete', { root: remoteRoot, paths: removed.slice(i, i + 500) });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - t0;
  let remoteRunId: number | null = null;
  try {
    const r = await callGateway('POST', `/targets/${target.id}/sync-report`, { dest: remoteRoot, project, uploaded: changed.length, deleted: removed.length, unchanged: summary.unchanged, bytes, ms, skipped, error, runId: turn.runId ?? undefined });
    remoteRunId = typeof r.remoteRunId === 'number' ? r.remoteRunId : null;
  } catch { /* report is best effort */ }
  if (error) throw new Error(`동기화 중 오류: ${error}`);
  return {
    ...summary, ms, remoteRunId,
    hint: `대상에서 실행할 때 cwd는 "${remoteRoot}". 의존성(node_modules 등)은 복사하지 않으므로 필요하면 먼저 설치(npm ci 등)하세요.`,
  };
}
