import { promises as fs } from 'node:fs';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError, normalizeProjectPath, PROJECTS_HOME, validateWorkspacePath, WORKSPACES_ROOT } from '@/shared/utils.js';

function uniqueJsonlPathsFromSessions(
  sessions: Array<{ jsonl_path: string | null }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const row of sessions) {
    const raw = row.jsonl_path?.trim();
    if (!raw) {
      continue;
    }
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    result.push(absolute);
  }

  return result;
}

async function unlinkJsonlIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    console.warn(`[project-delete] Failed to remove ${filePath}:`, (error as Error).message);
  }
}

/**
 * Loads all session rows for the project path and removes each distinct `jsonl_path` file on disk.
 */
export async function deleteSessionJsonlFilesForProjectPath(projectPath: string): Promise<void> {
  const sessions = sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath);
  // Including the transcripts a session has left behind: editing a message on
  // a provider that rewinds by branching moves the session onto a copy, and
  // the row stops pointing at the file the replaced turns are still in.
  const paths = uniqueJsonlPathsFromSessions([
    ...sessions,
    ...sessions.flatMap((session) => sessionsDb
      .getSupersededTranscriptPaths(session.session_id)
      .map((jsonl_path) => ({ jsonl_path }))),
  ]);

  for (const filePath of paths) {
    await unlinkJsonlIfExists(filePath);
  }

  for (const session of sessions) {
    sessionsDb.clearSupersededProviderSessions(session.session_id);
  }
}

/**
 * Deletes a project's folder from disk — the "폴더까지 삭제" choice, never a side
 * effect of any other removal.
 *
 * Refuses anything that is not plainly one project's own folder: a path outside
 * the workspace root or in a system directory (`validateWorkspacePath`), the
 * workspace root and projects home themselves, a symlink or file, and a folder
 * that holds another registered project. A folder already gone is not an error.
 * Only the local folder goes; a remote repository (GitHub) is never touched.
 */
async function removeProjectFolder(projectId: string, projectPath: string): Promise<void> {
  const refuse = (message: string) => new AppError(message, { code: 'PROJECT_FOLDER_DELETE_REFUSED', statusCode: 400 });

  const validation = await validateWorkspacePath(projectPath);
  if (!validation.valid || !validation.resolvedPath) {
    throw refuse(`이 폴더는 지울 수 없습니다: ${validation.error ?? projectPath}`);
  }
  const folder = validation.resolvedPath;

  const roots = await Promise.all([WORKSPACES_ROOT, PROJECTS_HOME].map(async (root) => (
    normalizeProjectPath(await fs.realpath(root).catch(() => root))
  )));
  if (roots.includes(folder)) {
    throw refuse('작업 공간의 최상위 폴더는 지울 수 없습니다');
  }

  try {
    const stats = await fs.lstat(projectPath);
    if (!stats.isDirectory()) {
      throw refuse('폴더가 아니어서 지우지 않았습니다 (링크이거나 파일입니다)');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const holdsAnotherProject = [...projectsDb.getProjectPaths(), ...projectsDb.getArchivedProjectPaths()]
    .filter((row) => row.project_id !== projectId)
    .some((row) => [folder, normalizeProjectPath(projectPath)].some((candidate) => (
      row.project_path === candidate || row.project_path.startsWith(`${candidate}${path.sep}`)
    )));
  if (holdsAnotherProject) {
    throw refuse('이 폴더 안에 다른 프로젝트가 있어 지우지 않았습니다');
  }

  await fs.rm(folder, { recursive: true, force: true });
}

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): for each session row for that `project_path`, delete the file at `jsonl_path`
 *   (when set), then remove session rows and the `projects` row. The project folder stays on disk.
 * - **Folder** (`force` and `deleteFolder` true): the folder is deleted first, so a refused or failed folder
 *   deletion leaves the project listed as it was.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean, deleteFolder = false): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    return;
  }

  if (deleteFolder) {
    await removeProjectFolder(projectId, row.project_path);
  }

  await deleteSessionJsonlFilesForProjectPath(row.project_path);
  sessionsDb.deleteSessionsByProjectPath(row.project_path);
  projectsDb.deleteProjectById(projectId);
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
}
