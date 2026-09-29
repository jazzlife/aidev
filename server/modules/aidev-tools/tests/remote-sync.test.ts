import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listProjectFiles, resolveProjectDir } from '@/modules/aidev-tools/remote-sync.service.js';

/** remote_sync (F-04): which files leave the runtime, and which folders may be a source. */
function project(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-src-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('plain folder: .gitignore, .aidevignore and the defaults are honoured', async () => {
  const dir = project({
    'package.json': '{}', 'src/App.tsx': 'x', '.gitignore': 'dist/\n*.log\n', '.aidevignore': 'secrets/\n',
    'dist/bundle.js': 'x', 'debug.log': 'x', 'secrets/key.pem': 'x', 'node_modules/a/index.js': 'x', '.DS_Store': 'x', '.venv/bin/python': 'x',
  });
  assert.deepEqual(await listProjectFiles(dir), ['.aidevignore', '.gitignore', 'package.json', 'src/App.tsx']);
});

test('git repo: tracked + untracked-not-ignored, deleted tracked files dropped later', async () => {
  const dir = project({ 'a.txt': 'a', 'b.txt': 'b', '.gitignore': 'out/\n', 'out/x': 'x', '.aidevignore': 'b.txt\n' });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', 'a.txt', '.gitignore'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n');
  assert.deepEqual(await listProjectFiles(dir), ['.aidevignore', '.gitignore', 'a.txt', 'new.txt']);
});

test('source folder: absolute, workspace name, session cwd; never the home folder', () => {
  const dir = project({ 'x': '1' });
  assert.equal(resolveProjectDir(dir, null), fs.realpathSync(dir));
  assert.equal(resolveProjectDir(undefined, dir), fs.realpathSync(dir));
  assert.throws(() => resolveProjectDir(os.homedir(), null), /홈 폴더/);
  assert.throws(() => resolveProjectDir('/definitely/missing', null), /없습니다/);
  assert.throws(() => resolveProjectDir(undefined, null), /필요/);
});
