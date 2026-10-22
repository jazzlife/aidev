import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// The workspace root is read once at module load, so it is set before the
// modules under test are imported.
const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'project-delete-'));
process.env.WORKSPACES_ROOT = workspaceRoot;
process.env.PROJECTS_HOME = workspaceRoot;

const { projectsDb, sessionsDb } = await import('@/modules/database/index.js');
const { deleteOrArchiveProject } = await import('@/modules/projects/services/project-delete.service.js');
const { AppError } = await import('@/shared/utils.js');

type Row = { project_id: string; project_path: string; custom_project_name: string | null; isStarred: number; isArchived: number };

let rows: Row[] = [];
const row = (projectId: string, projectPath: string): Row => ({
  project_id: projectId,
  project_path: projectPath,
  custom_project_name: null,
  isStarred: 0,
  isArchived: 0,
});

projectsDb.getProjectById = (projectId: string) => rows.find((entry) => entry.project_id === projectId) ?? null;
projectsDb.getProjectPaths = () => rows.filter((entry) => !entry.isArchived);
projectsDb.getArchivedProjectPaths = () => rows.filter((entry) => entry.isArchived);
projectsDb.deleteProjectById = (projectId: string) => { rows = rows.filter((entry) => entry.project_id !== projectId); };
projectsDb.updateProjectIsArchivedById = (projectId: string, isArchived: boolean) => {
  rows = rows.map((entry) => (entry.project_id === projectId ? { ...entry, isArchived: isArchived ? 1 : 0 } : entry));
};
sessionsDb.getSessionsByProjectPathIncludingArchived = () => [];
sessionsDb.deleteSessionsByProjectPath = () => undefined as never;

beforeEach(() => { rows = []; });
after(async () => { await rm(workspaceRoot, { recursive: true, force: true }); });

const makeFolder = async (name: string) => {
  const folder = path.join(workspaceRoot, name);
  await mkdir(path.join(folder, '.git'), { recursive: true });
  return folder;
};

test('archiving keeps the row (hidden) and the folder', async () => {
  const folder = await makeFolder('archived');
  rows = [row('p1', folder)];

  await deleteOrArchiveProject('p1', false);

  assert.equal(rows[0]?.isArchived, 1);
  assert.ok(existsSync(folder));
});

test('removing the bookmark only leaves the folder and its repository on disk', async () => {
  const folder = await makeFolder('bookmark-only');
  rows = [row('p1', folder)];

  await deleteOrArchiveProject('p1', true);

  assert.equal(rows.length, 0);
  assert.ok(existsSync(path.join(folder, '.git')));
});

test('deleting the folder removes it from disk and the project from the list', async () => {
  const folder = await makeFolder('with-folder');
  rows = [row('p1', folder)];

  await deleteOrArchiveProject('p1', true, true);

  assert.equal(rows.length, 0);
  assert.ok(!existsSync(folder));
});

test('a folder holding another project is refused and nothing is removed', async () => {
  const folder = await makeFolder('parent');
  const nested = await makeFolder('parent/child');
  rows = [row('p1', folder), { ...row('p2', nested), isArchived: 1 }];

  await assert.rejects(
    deleteOrArchiveProject('p1', true, true),
    (error: unknown) => error instanceof AppError && error.code === 'PROJECT_FOLDER_DELETE_REFUSED',
  );

  assert.equal(rows.length, 2);
  assert.ok(existsSync(nested));
});

test('the workspace root itself is never deleted', async () => {
  rows = [row('p1', workspaceRoot)];

  await assert.rejects(
    deleteOrArchiveProject('p1', true, true),
    (error: unknown) => error instanceof AppError && error.code === 'PROJECT_FOLDER_DELETE_REFUSED',
  );

  assert.equal(rows.length, 1);
  assert.ok(existsSync(workspaceRoot));
});
