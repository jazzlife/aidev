import { RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter } from '@codemirror/view';

import { debugStore } from '@/modules/remote-debug';

/**
 * The code editor's breakpoint gutter (F-09): click left of a line number to set/clear a breakpoint on that
 * line of the workspace file; the line where the selected debug session is paused is highlighted. Both come
 * from debugStore, so the debug window (DebugPane) and every open editor stay in step; the pane sends the
 * breakpoints of a mapped project to the running session. Used by CodeEditor.
 */
type Info = { lines: number[]; paused: number | null };

class BreakpointMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement('div');
    dot.className = 'cm-aidev-bp';
    dot.title = '중단점 (클릭해서 해제)';
    return dot;
  }
}
const marker = new BreakpointMarker();
class SpacerMarker extends GutterMarker { toDOM() { const d = document.createElement('div'); d.className = 'cm-aidev-bp-space'; return d; } }
const spacer = new SpacerMarker();

const setInfo = StateEffect.define<Info>();
const infoField = StateField.define<Info>({
  create: () => ({ lines: [], paused: null }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInfo)) return e.value;
    return value;
  },
});

const pausedLine = Decoration.line({ class: 'cm-aidev-paused-line' });

const theme = EditorView.baseTheme({
  '.cm-aidev-bp-gutter .cm-gutterElement': { cursor: 'pointer', width: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-aidev-bp-gutter .cm-gutterElement:hover:not(:has(.cm-aidev-bp))::after': { content: '""', width: '9px', height: '9px', borderRadius: '50%', background: 'rgba(220, 38, 38, 0.35)' },
  '.cm-aidev-bp': { width: '9px', height: '9px', borderRadius: '50%', background: '#dc2626' },
  '.cm-aidev-bp-space': { width: '9px' },
  '.cm-aidev-paused-line': { backgroundColor: 'rgba(250, 204, 21, 0.28) !important' },
});

function infoFor(path: string): Info {
  const s = debugStore.get();
  return { lines: debugStore.lines(path), paused: s.paused?.runtimePath === path ? s.paused.line : null };
}
const same = (a: Info, b: Info) => a.paused === b.paused && a.lines.length === b.lines.length && a.lines.every((l, i) => l === b.lines[i]);

/** The gutter + paused-line highlight for one workspace file (absolute path, as debugStore keys it). */
export function debugGutter(path: string): Extension {
  const sync = ViewPlugin.define((view) => {
    const push = () => {
      const next = infoFor(path);
      if (!same(view.state.field(infoField), next)) view.dispatch({ effects: setInfo.of(next) });
    };
    // an effect cannot be dispatched while the editor is still being constructed
    queueMicrotask(push);
    const unsubscribe = debugStore.subscribe(() => queueMicrotask(push));
    return { destroy: unsubscribe };
  });
  return [
    infoField,
    sync,
    theme,
    gutter({
      class: 'cm-aidev-bp-gutter',
      markers: (view) => {
        const { lines } = view.state.field(infoField);
        const doc = view.state.doc;
        return RangeSet.of(lines.filter((l) => l <= doc.lines).map((l) => marker.range(doc.line(l).from)), true);
      },
      initialSpacer: () => spacer,
      domEventHandlers: {
        mousedown(view, block) {
          debugStore.toggle(path, view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    EditorView.decorations.compute([infoField], (state) => {
      const { paused } = state.field(infoField);
      if (!paused || paused > state.doc.lines) return Decoration.none;
      return Decoration.set([pausedLine.range(state.doc.line(paused).from)]);
    }),
  ];
}
