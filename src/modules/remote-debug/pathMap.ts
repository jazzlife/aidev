/**
 * Paths between this workspace (the runtime, where the editor's files live) and the user's PC (where the
 * program runs under the debugger). A project copied with remote_sync lands at <PC folder>/<project name>,
 * so one root pair maps every file of it. Used by the debug store, the editor gutter and DebugPane.
 */
export type DebugPathMap = { runtimeRoot: string; targetRoot: string };

const trimEnd = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
const winLike = (p: string) => /^[A-Za-z]:\\/.test(p) || (p.includes('\\') && !p.includes('/'));

/** `runtimePath` (inside runtimeRoot) as a path on the PC; null when it is not under the mapped project. */
export function toTargetPath(runtimePath: string, map: DebugPathMap | null): string | null {
  if (!map) return null;
  const root = trimEnd(map.runtimeRoot);
  if (runtimePath !== root && !runtimePath.startsWith(`${root}/`)) return null;
  const rel = runtimePath.slice(root.length).replace(/^\/+/, '');
  const target = trimEnd(map.targetRoot);
  if (!rel) return target;
  return winLike(target) ? `${target}\\${rel.replace(/\//g, '\\')}` : `${target}/${rel}`;
}

/** A path on the PC (inside targetRoot) as the workspace file; null when it is outside the mapped folder. */
export function toRuntimePath(targetPath: string, map: DebugPathMap | null): string | null {
  if (!map) return null;
  const target = trimEnd(map.targetRoot);
  const win = winLike(target);
  const norm = (p: string) => (win ? p.toLowerCase().replace(/\//g, '\\') : p);
  const sep = win ? '\\' : '/';
  if (norm(targetPath) !== norm(target) && !norm(targetPath).startsWith(norm(target) + sep)) return null;
  const rel = targetPath.slice(target.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  const root = trimEnd(map.runtimeRoot);
  return rel ? `${root}/${rel}` : root;
}

const base = (p: string) => trimEnd(p).split(/[\\/]/).pop() ?? '';

/** For a session nobody mapped (an agent started it): the workspace project whose folder name matches the session's folder. */
export function guessPathMap(sessionCwd: string | null, projectPath: string | null): DebugPathMap | null {
  if (!sessionCwd || !projectPath) return null;
  return base(sessionCwd) && base(sessionCwd) === base(projectPath) ? { runtimeRoot: trimEnd(projectPath), targetRoot: trimEnd(sessionCwd) } : null;
}

/** Where remote_sync puts a project by default: <first allowed folder>/<project folder name> (the runner resolves `~`). */
export function defaultTargetFolder(projectPath: string | null, allowedRoots: string[]) {
  const name = projectPath ? base(projectPath) : '';
  const root = allowedRoots[0] ?? '~/aidev-work';
  return name ? `${trimEnd(root)}/${name}` : root;
}

/** The adapter for a program: .py → debugpy, .js/.ts … → js-debug, anything else (a binary) → codelldb. */
export function adapterFor(program: string): 'js-debug' | 'debugpy' | 'codelldb' {
  if (/\.py$/i.test(program)) return 'debugpy';
  if (/\.(m|c)?(j|t)sx?$/i.test(program)) return 'js-debug';
  return 'codelldb';
}

/** "a b 'c d'" → ["a", "b", "c d"] (the program arguments field). */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}
