import { lazyComponent } from '@/shared/utils';

/**
 * Used by EditorSidebar here and, through the barrel, by the workbench editor group: the CodeMirror
 * editor downloads when a file is first opened instead of with the app's first screen.
 */
export const LazyCodeEditor = /* @__PURE__ */ lazyComponent(() => import('@/modules/code-editor/CodeEditor').then((module) => module.default));
