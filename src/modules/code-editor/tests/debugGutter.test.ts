import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { debugStore } from '@/modules/remote-debug';
import { debugGutter } from '@/modules/code-editor/utils/debugGutter';

/** F-09: the editor's breakpoint gutter follows debugStore and writes clicks back to it. */
const PATH = '/home/u/workspace/app/src/a.js';
const tick = () => new Promise((r) => setTimeout(r, 0));
let view: EditorView | null = null;
afterEach(() => { view?.destroy(); view = null; debugStore.setLines(PATH, []); debugStore.setPaused(null); });

function mount() {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({ state: EditorState.create({ doc: ['a', 'b', 'c', 'd'].join('\n'), extensions: [debugGutter(PATH)] }), parent });
  return view;
}

describe('debug gutter (F-09)', () => {
  it('shows the store\'s breakpoints and the paused line of this file', async () => {
    debugStore.setLines(PATH, [2]);
    const v = mount();
    await tick();
    expect(v.dom.querySelectorAll('.cm-aidev-bp').length).toBe(1);
    debugStore.setLines(PATH, [2, 4]);
    await tick();
    expect(v.dom.querySelectorAll('.cm-aidev-bp').length).toBe(2);
    debugStore.setPaused({ sessionId: 's1', runtimePath: PATH, targetPath: '/pc/a.js', line: 3 });
    await tick();
    const paused = v.dom.querySelectorAll('.cm-aidev-paused-line');
    expect(paused.length).toBe(1);
    expect(paused[0].textContent).toBe('c');
    debugStore.setPaused({ sessionId: 's1', runtimePath: '/other.js', targetPath: '/pc/o.js', line: 3 });
    await tick();
    expect(v.dom.querySelectorAll('.cm-aidev-paused-line').length).toBe(0);
  });

  it('a click in the gutter toggles the breakpoint of that line', async () => {
    const v = mount();
    await tick();
    const cells = [...v.dom.querySelectorAll('.cm-aidev-bp-gutter .cm-gutterElement')].filter((el) => (el as HTMLElement).style.height !== '');
    // the second visible line cell (line 2)
    const line2 = cells[1] ?? cells[0];
    line2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }));
    await tick();
    expect(debugStore.lines(PATH).length).toBe(1);
  });
});
