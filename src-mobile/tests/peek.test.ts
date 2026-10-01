import { describe, expect, it } from 'vitest';

import { fileEditFromTool, filePathFromTool, fileRefFromText, languageFor } from '@m/lib/peek';

describe('fileRefFromText', () => {
  it('reads paths with and without a line', () => {
    expect(fileRefFromText('src/app.ts:12')).toEqual({ path: 'src/app.ts', line: 12 });
    expect(fileRefFromText('src/app.ts:12:5')).toEqual({ path: 'src/app.ts', line: 12 });
    expect(fileRefFromText('/home/claude/p/index.html')).toEqual({ path: '/home/claude/p/index.html', line: null });
    expect(fileRefFromText('./a/b.py')).toEqual({ path: './a/b.py', line: null });
  });

  it('takes a bare file name only with a known extension or a line', () => {
    expect(fileRefFromText('package.json')).toEqual({ path: 'package.json', line: null });
    expect(fileRefFromText('notes.weird:3')).toEqual({ path: 'notes.weird', line: 3 });
    expect(fileRefFromText('console.log')).toBeNull();
    expect(fileRefFromText('v1.2')).toBeNull();
  });

  it('ignores code that is not a path', () => {
    expect(fileRefFromText('npm run build')).toBeNull();
    expect(fileRefFromText('useState()')).toBeNull();
    expect(fileRefFromText('src/')).toBeNull();
  });
});

describe('fileEditFromTool', () => {
  it('reads Claude Edit input (also as a JSON string)', () => {
    const input = JSON.stringify({ file_path: '/p/a.ts', old_string: 'a', new_string: 'b' });
    expect(fileEditFromTool('Edit', input)).toEqual({ path: '/p/a.ts', hunks: [{ before: 'a', after: 'b' }], created: false, deleted: false });
  });

  it('reads every MultiEdit hunk', () => {
    const edit = fileEditFromTool('MultiEdit', { file_path: '/p/a.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] });
    expect(edit?.hunks).toEqual([{ before: '1', after: '2' }, { before: '3', after: '4' }]);
  });

  it('treats Write as a new file — Claude content or Codex new_string', () => {
    expect(fileEditFromTool('Write', { file_path: '/p/n.md', content: 'x' })?.hunks).toEqual([{ before: '', after: 'x' }]);
    expect(fileEditFromTool('Write', { file_path: '/p/n.md', old_string: '', new_string: 'y' })).toMatchObject({ created: true, hunks: [{ before: '', after: 'y' }] });
  });

  it('marks a Codex delete and ignores other tools', () => {
    expect(fileEditFromTool('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: '', deleted: true })?.deleted).toBe(true);
    expect(fileEditFromTool('Bash', { command: 'ls' })).toBeNull();
    expect(fileEditFromTool('Edit', { old_string: 'a' })).toBeNull();
  });
});

describe('filePathFromTool / languageFor', () => {
  it('peeks only what Read looked at', () => {
    expect(filePathFromTool('Read', { file_path: '/p/a.ts' })).toBe('/p/a.ts');
    expect(filePathFromTool('Grep', { path: '/p' })).toBeNull();
  });

  it('maps extensions onto the eight shipped grammars', () => {
    expect(languageFor('a/b.tsx')).toBe('typescript');
    expect(languageFor('index.HTML')).toBe('xml');
    expect(languageFor('ci.yml')).toBe('yaml');
    expect(languageFor('main.rs')).toBeNull();
    expect(languageFor('Makefile')).toBeNull();
  });
});
