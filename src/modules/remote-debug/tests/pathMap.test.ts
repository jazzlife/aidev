import { describe, expect, it } from 'vitest';

import { adapterFor, defaultTargetFolder, guessPathMap, splitArgs, toRuntimePath, toTargetPath } from '@/modules/remote-debug/pathMap';
import { debugStore } from '@/modules/remote-debug/debugStore';

const mac = { runtimeRoot: '/home/u/workspace/todo', targetRoot: '/Users/me/aidev-work/todo' };
const win = { runtimeRoot: '/home/u/workspace/todo', targetRoot: 'C:\\Users\\me\\aidev-work\\todo' };

describe('debug path mapping (F-09)', () => {
  it('maps workspace files to the PC folder and back', () => {
    expect(toTargetPath('/home/u/workspace/todo/src/app.js', mac)).toBe('/Users/me/aidev-work/todo/src/app.js');
    expect(toRuntimePath('/Users/me/aidev-work/todo/src/app.js', mac)).toBe('/home/u/workspace/todo/src/app.js');
    expect(toTargetPath('/home/u/workspace/todo-2/a.js', mac)).toBeNull();
    expect(toRuntimePath('/Users/me/other/a.js', mac)).toBeNull();
    expect(toTargetPath('/home/u/workspace/todo/src/app.js', win)).toBe('C:\\Users\\me\\aidev-work\\todo\\src\\app.js');
    expect(toRuntimePath('c:\\users\\me\\aidev-work\\todo\\src\\app.js', win)).toBe('/home/u/workspace/todo/src/app.js');
    expect(toTargetPath('/x', null)).toBeNull();
  });
  it('guesses the project of an agent session by folder name, and the default sync folder', () => {
    expect(guessPathMap('/Users/me/aidev-work/todo', '/home/u/workspace/todo/')).toEqual({ runtimeRoot: '/home/u/workspace/todo', targetRoot: '/Users/me/aidev-work/todo' });
    expect(guessPathMap('/Users/me/aidev-work/other', '/home/u/workspace/todo')).toBeNull();
    expect(defaultTargetFolder('/home/u/workspace/todo', ['/Users/me/aidev-work'])).toBe('/Users/me/aidev-work/todo');
    expect(defaultTargetFolder(null, [])).toBe('~/aidev-work');
  });
  it('picks the adapter from the program and splits arguments', () => {
    expect([adapterFor('main.py'), adapterFor('src/index.ts'), adapterFor('app.mjs'), adapterFor('target/debug/app')]).toEqual(['debugpy', 'js-debug', 'js-debug', 'codelldb']);
    expect(splitArgs(`--port 3000 "a b" 'c d' e\\"f`)).toEqual(['--port', '3000', 'a b', 'c d', 'e\\"f']);
  });
  it('keeps editor breakpoints sorted and unique, toggles them', () => {
    debugStore.setLines('/p/a.js', [5, 2, 5]);
    expect(debugStore.lines('/p/a.js')).toEqual([2, 5]);
    debugStore.toggle('/p/a.js', 2);
    debugStore.toggle('/p/a.js', 9);
    expect(debugStore.lines('/p/a.js')).toEqual([5, 9]);
    debugStore.setLines('/p/a.js', []);
    expect(debugStore.get().breakpoints['/p/a.js']).toBeUndefined();
  });
});
